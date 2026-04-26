/**
 * Helpers that support preserving DataStore conflict-resolution metadata
 * fields when a user disables conflict detection in `amplify update api`.
 *
 * Two exports:
 *
 *  - `injectSyncFields(schemaText)` — pure string → { string, lists } function
 *    that rewrites a user's `schema.graphql` so every `@model` declares the
 *    three DataStore metadata fields (`_version`, `_deleted`, `_lastChangedAt`)
 *    as regular user fields. Also enumerates any `@manyToMany` relations it
 *    detected so the caller can surface an actionable warning about the
 *    auto-synthesized join types (which this helper cannot reach).
 *
 *  - `buildMigrationChecklist(options)` — pure function returning the
 *    formatted console-output lines explaining what just happened and what
 *    the user must do next. Centralized so the interactive walkthrough and
 *    the headless artifact handler emit the exact same guidance.
 *
 * The module is intentionally pure: no filesystem, no logging, no prompts.
 * That makes it trivially testable and safe to call from either codepath.
 *
 * See the migration guide: https://github.com/aws-amplify/docs/pull/8578
 */
/* eslint-disable no-underscore-dangle */
import * as path from 'path';
import * as fs from 'fs-extra';
import { printer } from '@aws-amplify/amplify-prompts';
import chalk from 'chalk';
import {
  parse,
  print,
  visit,
  DocumentNode,
  ObjectTypeDefinitionNode,
  FieldDefinitionNode,
  DirectiveNode,
  ArgumentNode,
  StringValueNode,
  Kind,
} from 'graphql';

/**
 * URL of the migration guide surfaced in every warning message emitted by
 * this module. Kept as a named export so downstream docs/tests can reference
 * the single source of truth.
 */
export const MIGRATION_GUIDE_URL = 'https://github.com/aws-amplify/docs/pull/8578';

/**
 * The three DataStore/conflict-resolution metadata field names, in the
 * canonical order AppSync emits them.
 */
export const SYNC_FIELD_NAMES = ['_version', '_deleted', '_lastChangedAt'] as const;

/**
 * Mapping of sync-field name → GraphQL scalar type name used by AppSync.
 * `_lastChangedAt` uses the AppSync built-in `AWSTimestamp` scalar (epoch millis).
 */
const SYNC_FIELD_TYPES: Record<(typeof SYNC_FIELD_NAMES)[number], string> = {
  _version: 'Int',
  _deleted: 'Boolean',
  _lastChangedAt: 'AWSTimestamp',
};

/**
 * A single `@manyToMany` relation discovered during schema traversal.
 *
 * `relationName` matches the `relationName` argument the user passed, which
 * is also the name of the join type that the GraphQL transformer synthesizes
 * (e.g. `@manyToMany(relationName: "CardLabel")` → type `CardLabel`).
 *
 * `sourceModels` holds the model names on both sides of the relation —
 * usually two, but the helper does not enforce that.
 */
export interface ManyToManyRelation {
  /** The value of the `relationName` argument; also the synthesized join type name. */
  relationName: string;
  /** Names of user `@model` types that declared a field with this relationName. */
  sourceModels: string[];
}

/**
 * Result of {@link injectSyncFields}.
 */
export interface InjectSyncFieldsResult {
  /** Rewritten schema text (printed back from the AST). */
  updated: string;
  /**
   * Names of object types annotated with `@model` that were modified
   * (at least one of the three fields was missing and has been added).
   * Models that already declared all three fields are NOT included.
   */
  modifiedModels: string[];
  /**
   * Details of every `@manyToMany` relation discovered in the user's
   * schema, keyed by `relationName`. For each one the transformer
   * synthesizes a hidden join type (e.g. `relationName: "CardLabel"`
   * → synthesized `type CardLabel @model`). Those synthesized types are
   * NOT present in user-space `schema.graphql` and therefore CANNOT be
   * injected by this helper.
   */
  manyToManyRelations: ManyToManyRelation[];
}

/**
 * Options for {@link buildMigrationChecklist}.
 */
export interface MigrationChecklistOptions {
  /** Names of `@model` types that had one or more sync fields added. */
  modifiedModels: string[];
  /** Detail of `@manyToMany` relations the caller discovered. */
  manyToManyRelations: ManyToManyRelation[];
  /**
   * If true (default), wrap messages in `chalk` ANSI colour codes.
   * Set false for tests or log capture.
   */
  colored?: boolean;
}

/**
 * A single line of the migration checklist classified for the caller to
 * route to the right `printer` method (`info` / `warn`).
 */
export interface ChecklistLine {
  /** Which log level this line is meant for. */
  level: 'info' | 'warn';
  /** Pre-formatted message text, possibly with ANSI colour codes. */
  message: string;
}

/**
 * Read the `relationName` from a `@manyToMany(relationName: "Foo")` directive.
 * Returns `undefined` when the argument is absent or not a string literal
 * (handled gracefully to avoid crashing on malformed schemas).
 *
 * @param directive AST node for the `@manyToMany(...)` directive.
 * @returns the `relationName` string, or `undefined` if not present/invalid.
 */
const getRelationName = (directive: DirectiveNode): string | undefined => {
  const relArg = (directive.arguments ?? []).find((a: ArgumentNode) => a.name.value === 'relationName');
  if (!relArg) return undefined;
  if (relArg.value.kind !== Kind.STRING) return undefined;
  return (relArg.value as StringValueNode).value;
};

/**
 * Build a synthetic `FieldDefinitionNode` for one of the three sync fields.
 * Uses only named scalar types, so no wrappers are needed.
 *
 * @param fieldName one of the three sync field names.
 * @returns a `FieldDefinitionNode` with the correct scalar type and no directives.
 */
const buildSyncFieldNode = (fieldName: (typeof SYNC_FIELD_NAMES)[number]): FieldDefinitionNode => ({
  kind: Kind.FIELD_DEFINITION,
  name: { kind: Kind.NAME, value: fieldName },
  type: {
    kind: Kind.NAMED_TYPE,
    name: { kind: Kind.NAME, value: SYNC_FIELD_TYPES[fieldName] },
  },
  directives: [],
});

/**
 * Pre-inject the DataStore sync metadata fields (`_version`, `_deleted`,
 * `_lastChangedAt`) into every `@model` in the given schema.
 *
 * Behaviour:
 *  - Idempotent: a model that already declares all three fields is left
 *    alone and is not listed in `modifiedModels`.
 *  - Partial: a model that declares some but not all three fields gets the
 *    missing ones added (the existing declarations are preserved verbatim).
 *  - Scope: only object types with an `@model` directive are considered.
 *    Non-`@model` types (e.g. enums, custom types) are not touched.
 *  - `@manyToMany` awareness: every occurrence of `@manyToMany(relationName: "...")`
 *    is recorded against the relation name. The **synthesized** join type
 *    (not present in user schema) is NOT injected — the caller is expected
 *    to surface a warning via {@link buildMigrationChecklist}.
 *  - Directive preservation: existing field directives (`@auth`, `@hasMany`,
 *    `@belongsTo`, `@index`, …) on other fields are untouched.
 *
 * @param schemaText Raw contents of `amplify/backend/api/<name>/schema.graphql`.
 * @returns Object with the rewritten schema and the lists of affected types.
 */
export const injectSyncFields = (schemaText: string): InjectSyncFieldsResult => {
  const ast: DocumentNode = parse(schemaText, { noLocation: true });
  const modifiedModels: string[] = [];
  const relationsByName = new Map<string, Set<string>>();

  const rewritten = visit(ast, {
    ObjectTypeDefinition: {
      leave: (node: ObjectTypeDefinitionNode): ObjectTypeDefinitionNode | undefined => {
        const isModel = (node.directives ?? []).some((d: DirectiveNode) => d.name.value === 'model');
        if (!isModel) return undefined;

        for (const field of node.fields ?? []) {
          for (const directive of field.directives ?? []) {
            if (directive.name.value !== 'manyToMany') continue;
            const relationName = getRelationName(directive);
            if (!relationName) continue;
            let sources = relationsByName.get(relationName);
            if (!sources) {
              sources = new Set<string>();
              relationsByName.set(relationName, sources);
            }
            sources.add(node.name.value);
          }
        }

        const existingFieldNames = new Set((node.fields ?? []).map((f) => f.name.value));
        const toAdd: FieldDefinitionNode[] = SYNC_FIELD_NAMES.filter(
          (fieldName) => !existingFieldNames.has(fieldName),
        ).map(buildSyncFieldNode);

        if (toAdd.length === 0) {
          return undefined;
        }

        modifiedModels.push(node.name.value);
        return {
          ...node,
          fields: [...(node.fields ?? []), ...toAdd],
        };
      },
    },
  }) as DocumentNode;

  const manyToManyRelations: ManyToManyRelation[] = Array.from(relationsByName.entries())
    .map(([relationName, sources]) => ({
      relationName,
      sourceModels: Array.from(sources).sort(),
    }))
    .sort((a, b) => a.relationName.localeCompare(b.relationName));

  return {
    updated: print(rewritten),
    modifiedModels,
    manyToManyRelations,
  };
};

/**
 * Build the multi-line migration checklist emitted to the console after a
 * successful schema injection. Centralised so the interactive and headless
 * codepaths emit the exact same guidance.
 *
 * The caller is responsible for routing each line to the appropriate
 * `printer` method based on the `level` field.
 *
 * @param options see {@link MigrationChecklistOptions}.
 * @returns array of `{ level, message }` ready to pass to `printer.info` / `printer.warn`.
 */
export const buildMigrationChecklist = (options: MigrationChecklistOptions): ChecklistLine[] => {
  const colored = options.colored ?? true;
  const color = makeColorSet(colored);
  return [
    ...buildInjectionSummary(options.modifiedModels, color),
    ...buildHeader(color),
    ...buildManyToManySection(options.manyToManyRelations, color),
    ...buildRuntimeChangesSection(color),
    ...buildFooter(color),
  ];
};

interface ColorSet {
  cyan: (s: string) => string;
  yellow: (s: string) => string;
  yellowBold: (s: string) => string;
}

/**
 * Returns a set of colour-applying functions that either wrap strings in
 * chalk codes (when `colored` is true) or pass them through unchanged.
 *
 * @param colored if `true`, apply chalk ANSI codes; if `false`, return input unchanged.
 * @returns the three colour functions used by the checklist builders.
 */
const makeColorSet = (colored: boolean): ColorSet => ({
  cyan: (s: string): string => (colored ? chalk.cyan(s) : s),
  yellow: (s: string): string => (colored ? chalk.yellow(s) : s),
  yellowBold: (s: string): string => (colored ? chalk.yellow.bold(s) : s),
});

/**
 * Build the opening block: either an "already done, no changes" info line
 * or a cyan "Injected … into N @model types" line with a bullet per model.
 *
 * @param modifiedModels model names returned from `injectSyncFields`.
 * @param color colour helper.
 * @returns checklist lines describing what (if anything) was injected.
 */
const buildInjectionSummary = (modifiedModels: string[], color: ColorSet): ChecklistLine[] => {
  if (modifiedModels.length === 0) {
    return [
      {
        level: 'info',
        message: 'All @model types already declare _version / _deleted / _lastChangedAt — no schema changes needed.',
      },
    ];
  }
  const plural = modifiedModels.length === 1 ? '' : 's';
  return [
    {
      level: 'info',
      message: color.cyan(
        'Injected _version: Int, _deleted: Boolean, _lastChangedAt: AWSTimestamp ' +
          `into ${modifiedModels.length} @model type${plural}:`,
      ),
    },
    ...modifiedModels.map<ChecklistLine>((name) => ({ level: 'info', message: `  • ${name}` })),
  ];
};

/**
 * Build the "DataStore → AppSync migration checklist" banner.
 *
 * @param color colour helper.
 * @returns two warn lines (banner + intro) surrounded by blank spacer lines.
 */
const buildHeader = (color: ColorSet): ChecklistLine[] => [
  { level: 'warn', message: '' },
  { level: 'warn', message: color.yellowBold('⚠  DataStore → AppSync migration checklist') },
  {
    level: 'warn',
    message: color.yellow('   Disabling conflict detection is a breaking change for any code using DataStore.*.'),
  },
  { level: 'warn', message: '' },
];

/**
 * Build the @manyToMany-specific warning paragraph, or return `[]` if no
 * @manyToMany relations were detected.
 *
 * @param relations relations returned from `injectSyncFields`.
 * @param color colour helper.
 * @returns checklist lines explaining the impact of synthesized join types.
 */
const buildManyToManySection = (
  relations: ManyToManyRelation[],
  color: ColorSet,
): ChecklistLine[] => {
  if (relations.length === 0) return [];
  const lines: ChecklistLine[] = [
    {
      level: 'warn',
      message: color.yellowBold('   @manyToMany relations detected — the synthesized join types stay unchanged:'),
    },
  ];
  for (const rel of relations) {
    const sources = rel.sourceModels.join(' ↔ ');
    lines.push({
      level: 'warn',
      message: color.yellow(`     • ${rel.relationName}  (from ${sources})`),
    });
  }
  const prose = [
    '   These join types are synthesized by the transformer and are NOT in your schema.graphql,',
    '   so the sync-field injection above cannot reach them. Practical impact:',
    '     • If your app never queries the join table directly (typical), no code change is needed.',
    '     • Any rows in those join tables that were soft-deleted by DataStore (_deleted: true) will',
    '       remain in DynamoDB as orphan tombstones. Run a one-time cleanup scan over the join',
    '       tables (DynamoDB: Scan + DeleteItem where _deleted == true) if this bothers you.',
  ];
  for (const line of prose) {
    lines.push({ level: 'warn', message: color.yellow(line) });
  }
  lines.push({ level: 'warn', message: '' });
  return lines;
};

/**
 * Build the longest section — the three runtime-behaviour warnings about
 * hard-deletes, non-incrementing `_version`, and the absence of sync*
 * queries / observeQuery.
 *
 * @param color colour helper.
 * @returns checklist lines for the runtime-changes block.
 */
const buildRuntimeChangesSection = (color: ColorSet): ChecklistLine[] => {
  const prose = [
    '     • delete<Model> mutations become HARD deletes (the DynamoDB row is removed).',
    '       - Any UI that still treats _deleted: true as a soft-delete/tombstone will silently break.',
    '       - If your app lists records with `.filter(_deleted !== true)`, you can just remove the filter.',
    '       - If your app uses soft-delete as a "trash bin" UX, migrate to a custom mutation or add',
    '         an explicit `deletedAt: AWSDateTime` field and hide deleted rows in the client.',
    '     • _version is now a regular user field, NOT auto-incremented by AppSync resolvers.',
    '       - Values you write in mutation inputs round-trip through DynamoDB, but have no concurrency',
    '         semantics anymore — stale _version no longer triggers conflict handlers.',
    '     • sync<Model> queries and observeQuery subscriptions no longer exist.',
    '       Migrate to list<Model> + onCreate<Model>/onUpdate<Model>/onDelete<Model> subscriptions.',
  ];
  return [
    {
      level: 'warn',
      message: color.yellowBold('   Runtime behaviour changes you must handle in your app:'),
    },
    ...prose.map<ChecklistLine>((line) => ({ level: 'warn', message: color.yellow(line) })),
  ];
};

/**
 * Build the footer: a blank line, the migration-guide URL, and a trailing spacer.
 *
 * @param color colour helper.
 * @returns three checklist lines.
 */
const buildFooter = (color: ColorSet): ChecklistLine[] => [
  { level: 'warn', message: '' },
  { level: 'warn', message: color.yellow(`   Migration guide: ${MIGRATION_GUIDE_URL}`) },
  { level: 'warn', message: '' },
];

/**
 * File name of the one-time backup written next to `schema.graphql` the first
 * time {@link preserveSyncFieldsOnDisable} runs, so users can diff
 * before/after.
 */
export const SCHEMA_BACKUP_FILENAME = 'schema.graphql.pre-disable-backup';

/**
 * Route a list of {@link ChecklistLine}s to `printer`, per-line level.
 *
 * @param lines output of {@link buildMigrationChecklist}.
 */
const emitChecklist = (lines: ChecklistLine[]): void => {
  for (const line of lines) {
    if (line.level === 'warn') {
      printer.warn(line.message);
    } else {
      printer.info(line.message);
    }
  }
};

/**
 * End-to-end "preserve sync fields" side-effecting routine.
 *
 * Reads `<resourceDir>/schema.graphql`, runs {@link injectSyncFields} on it,
 * writes the rewritten schema back (creating a one-time backup at
 * `<resourceDir>/schema.graphql.pre-disable-backup`), and emits the migration
 * checklist to `printer`. Used by both the interactive `amplify update api`
 * walkthrough and the headless `cfn-api-artifact-handler` so the two
 * codepaths behave identically.
 *
 * Soft-fail semantics: any filesystem or parser error produces a
 * `printer.warn` describing what to do manually and returns. Disabling
 * conflict resolution is a destructive operation the user has explicitly
 * requested — failing loud here would strand them mid-update with a
 * confusing stack trace.
 *
 * See: https://github.com/aws-amplify/docs/pull/8578
 *
 * @param resourceDir Absolute path to `amplify/backend/api/<name>/`.
 */
export const preserveSyncFieldsOnDisable = async (resourceDir: string): Promise<void> => {
  const schemaPath = path.join(resourceDir, 'schema.graphql');
  if (!(await fs.pathExists(schemaPath))) {
    printer.warn(
      `preserveSyncFields: no schema.graphql at ${schemaPath} — skipping metadata field injection. ` +
        'If you use the split schema/ directory layout you will need to add _version/_deleted/_lastChangedAt manually.',
    );
    return;
  }

  let original: string;
  try {
    original = (await fs.readFile(schemaPath)).toString();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printer.warn(`preserveSyncFields: failed to read ${schemaPath}: ${msg}. Skipping injection.`);
    return;
  }

  let result: InjectSyncFieldsResult;
  try {
    result = injectSyncFields(original);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printer.warn(
      `preserveSyncFields: schema.graphql failed to parse (${msg}). ` +
        'Skipping injection — please add _version/_deleted/_lastChangedAt manually.',
    );
    return;
  }

  if (result.modifiedModels.length > 0) {
    const backupPath = path.join(resourceDir, SCHEMA_BACKUP_FILENAME);
    if (!(await fs.pathExists(backupPath))) {
      await fs.writeFile(backupPath, original);
    }
    await fs.writeFile(schemaPath, result.updated);
  }

  emitChecklist(
    buildMigrationChecklist({
      modifiedModels: result.modifiedModels,
      manyToManyRelations: result.manyToManyRelations,
    }),
  );
};
