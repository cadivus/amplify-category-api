/**
 * Preserves the DataStore sync fields (`_version`, `_deleted`, `_lastChangedAt`)
 * on `@model` types when a user disables conflict detection, so existing
 * DataStore client code keeps working.
 *
 * See: https://docs.amplify.aws/gen1/react/build-a-backend/more-features/datastore/migrate-from-datastore
 */
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

/** URL of the DataStore → AppSync migration guide, surfaced in warning messages. */
export const MIGRATION_GUIDE_URL = 'https://docs.amplify.aws/gen1/react/build-a-backend/more-features/datastore/migrate-from-datastore';

/** The three DataStore metadata field names, in the order AppSync emits them. */
export const SYNC_FIELD_NAMES = ['_version', '_deleted', '_lastChangedAt'] as const;

/** Scalar type for each sync field. `_lastChangedAt` uses AppSync's `AWSTimestamp`. */
const SYNC_FIELD_TYPES: Record<(typeof SYNC_FIELD_NAMES)[number], string> = {
  _version: 'Int',
  _deleted: 'Boolean',
  _lastChangedAt: 'AWSTimestamp',
};

/**
 * A `@manyToMany` relation discovered during schema traversal. `relationName`
 * is also the name of the join type the transformer synthesizes.
 */
export interface ManyToManyRelation {
  /** Value of the `relationName` arg; also the synthesized join type name. */
  relationName: string;
  /** `@model` types that declared a field with this relationName. */
  sourceModels: string[];
}

/** Result of {@link injectSyncFields}. */
export interface InjectSyncFieldsResult {
  /** Rewritten schema text. */
  updated: string;
  /** `@model` types where at least one sync field was added. */
  modifiedModels: string[];
  /** `@manyToMany` relations discovered (their join types cannot be injected). */
  manyToManyRelations: ManyToManyRelation[];
}

/** Options for {@link buildMigrationChecklist}. */
export interface MigrationChecklistOptions {
  modifiedModels: string[];
  manyToManyRelations: ManyToManyRelation[];
  /**
   * When `false`, emit only the short per-invocation summary (injection count
   * or "no changes needed") and skip the verbose migration guide block.
   * Defaults to `true`. Process-scoped deduplication uses this to suppress
   * repeat prints when `preserveSyncFieldsOnDisable` is called more than once
   * per CLI invocation (interactive walkthrough → headless artifact handler).
   */
  includeVerboseChecklist?: boolean;
}

/** One line of the migration checklist, tagged with the target log level. */
export interface ChecklistLine {
  level: 'info' | 'warn';
  message: string;
}

/** Read `relationName` from a `@manyToMany(relationName: "Foo")` directive. */
const getRelationName = (directive: DirectiveNode): string | undefined => {
  const relArg = (directive.arguments ?? []).find((a: ArgumentNode) => a.name.value === 'relationName');
  if (!relArg) return undefined;
  if (relArg.value.kind !== Kind.STRING) return undefined;
  return (relArg.value as StringValueNode).value;
};

/** Build a synthetic AST node for one sync field. */
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
 * Inject `_version`, `_deleted`, `_lastChangedAt` into every `@model` that
 * doesn't already declare them. Idempotent; partial states are filled in;
 * non-`@model` types and other directives are left untouched.
 *
 * `@manyToMany` occurrences are recorded but NOT injected — the synthesized
 * join type lives outside the user schema.
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
 * Build the migration checklist shared by the interactive and headless
 * disable codepaths. Caller routes each line to `printer.info` / `printer.warn`
 * based on its `level`.
 *
 * When `includeVerboseChecklist` is `false`, only the short injection summary
 * is returned (no header, no manyToMany block, no runtime-changes block, no
 * footer). This is how {@link preserveSyncFieldsOnDisable} suppresses the
 * repeat verbose block on its second call within a single CLI invocation.
 */
export const buildMigrationChecklist = (options: MigrationChecklistOptions): ChecklistLine[] => {
  const summary = buildInjectionSummary(options.modifiedModels);
  if (options.includeVerboseChecklist === false) {
    return summary;
  }
  return [
    ...summary,
    ...buildHeader(),
    ...buildManyToManySection(options.manyToManyRelations),
    ...buildRuntimeChangesSection(),
    ...buildFooter(),
  ];
};

/** Opening block: either "no changes needed" or the per-model injection list. */
const buildInjectionSummary = (modifiedModels: string[]): ChecklistLine[] => {
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
      message: chalk.cyan(
        'Injected _version: Int, _deleted: Boolean, _lastChangedAt: AWSTimestamp ' +
          `into ${modifiedModels.length} @model type${plural}:`,
      ),
    },
    ...modifiedModels.map<ChecklistLine>((name) => ({ level: 'info', message: `  • ${name}` })),
  ];
};

/** Banner + intro for the migration checklist. */
const buildHeader = (): ChecklistLine[] => [
  { level: 'warn', message: '' },
  { level: 'warn', message: chalk.yellow.bold('⚠  DataStore → AppSync migration checklist') },
  {
    level: 'warn',
    message: chalk.yellow('   Disabling conflict detection is a breaking change for any code using DataStore.*.'),
  },
  { level: 'warn', message: '' },
];

/** `@manyToMany` section, empty when no such relations exist. */
const buildManyToManySection = (relations: ManyToManyRelation[]): ChecklistLine[] => {
  if (relations.length === 0) return [];
  const lines: ChecklistLine[] = [
    {
      level: 'warn',
      message: chalk.yellow.bold('   @manyToMany relations detected — the synthesized join types stay unchanged:'),
    },
  ];
  for (const rel of relations) {
    const sources = rel.sourceModels.join(' ↔ ');
    lines.push({
      level: 'warn',
      message: chalk.yellow(`     • ${rel.relationName}  (from ${sources})`),
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
    lines.push({ level: 'warn', message: chalk.yellow(line) });
  }
  lines.push({ level: 'warn', message: '' });
  return lines;
};

/** Runtime-behaviour warnings (hard delete, non-incrementing _version, missing sync queries). */
const buildRuntimeChangesSection = (): ChecklistLine[] => {
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
      message: chalk.yellow.bold('   Runtime behaviour changes you must handle in your app:'),
    },
    ...prose.map<ChecklistLine>((line) => ({ level: 'warn', message: chalk.yellow(line) })),
  ];
};

/** Footer: migration-guide URL surrounded by blank spacers. */
const buildFooter = (): ChecklistLine[] => [
  { level: 'warn', message: '' },
  { level: 'warn', message: chalk.yellow(`   Migration guide: ${MIGRATION_GUIDE_URL}`) },
  { level: 'warn', message: '' },
];

/** Backup file written next to `schema.graphql` on the first disable. */
export const SCHEMA_BACKUP_FILENAME = 'schema.graphql.pre-disable-backup';

/**
 * Process-scoped flag: has the verbose migration checklist been emitted yet?
 *
 * Within a single CLI invocation, `preserveSyncFieldsOnDisable` can be reached
 * twice — once from the interactive `appSync-walkthrough.ts` after the user
 * confirms the prompt, and a second time from `cfn-api-artifact-handler.ts`
 * when the same CLI session flushes the headless update during `amplify push`.
 * Both entry points are intentional (one is interactive, the other is a
 * machine-readable payload path); we don't want to re-architect the call
 * graph just to suppress one log block. Instead we set this flag the first
 * time the verbose checklist is emitted and downgrade every subsequent call
 * within the same process to the short "already injected" summary.
 *
 * The flag resets between Node processes, so each fresh CLI invocation gets
 * one verbose print. It is intentionally NOT persisted to disk.
 */
let verboseChecklistAlreadyEmitted = false;

/**
 * Reset the process-scoped "verbose checklist already emitted" flag.
 *
 * Exported only for tests — production callers have no reason to call this.
 * The `__` prefix follows the internal-API convention.
 */
export const __resetVerboseChecklistGuard = (): void => {
  verboseChecklistAlreadyEmitted = false;
};

/** Route checklist lines to `printer` per their `level`. */
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
 * Rewrite `<resourceDir>/schema.graphql` to keep the three sync fields,
 * write a one-time backup, and emit the migration checklist.
 *
 * Soft-fails on I/O or parse errors — the walkthrough shouldn't crash
 * mid-disable.
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

  const includeVerboseChecklist = !verboseChecklistAlreadyEmitted;
  emitChecklist(
    buildMigrationChecklist({
      modifiedModels: result.modifiedModels,
      manyToManyRelations: result.manyToManyRelations,
      includeVerboseChecklist,
    }),
  );
  if (includeVerboseChecklist) {
    verboseChecklistAlreadyEmitted = true;
  }
};
