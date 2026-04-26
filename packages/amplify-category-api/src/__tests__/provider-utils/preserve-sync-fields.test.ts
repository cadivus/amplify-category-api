/**
 * Unit tests for {@link injectSyncFields} and {@link buildMigrationChecklist}.
 *
 * Both functions are pure (string in → string / string-array out) so the
 * tests here are filesystem- and network-free. They cover:
 *
 *  - happy path: fields added to a bare @model
 *  - idempotency (running twice is a no-op)
 *  - partial state (only one or two sync fields already present)
 *  - scope: non-@model object types are ignored
 *  - @manyToMany relations are enumerated by relationName + source models
 *  - @auth / @hasMany / @belongsTo / @index survive round-tripping
 *  - correct scalar types (Int, Boolean, AWSTimestamp)
 *  - checklist content for the three distinct cases (nothing-to-do,
 *    schema-modified-no-m2m, m2m-detected) and opt-out of colour codes.
 */
import {
  buildMigrationChecklist,
  injectSyncFields,
  MIGRATION_GUIDE_URL,
  SYNC_FIELD_NAMES,
} from '../../provider-utils/awscloudformation/helpers/preserve-sync-fields';

/**
 * Assert that all three sync fields are present on a given @model type in
 * the printed schema. Walks the AST so directive braces don't confuse naive
 * regex matching.
 *
 * @param schema GraphQL SDL string to inspect.
 * @param typeName Name of the object type to check.
 * @returns `true` when all three sync fields are present with the expected
 *          scalar types; `false` otherwise.
 */
/* eslint-disable no-underscore-dangle, @typescript-eslint/no-var-requires, global-require */
const hasAllSyncFields = (schema: string, typeName: string): boolean => {
  const { parse, visit } = require('graphql');
  const ast = parse(schema, { noLocation: true });
  const found = { _version: false, _deleted: false, _lastChangedAt: false };
  visit(ast, {
    ObjectTypeDefinition: (node: {
      name: { value: string };
      fields?: ReadonlyArray<{
        name: { value: string };
        type: { kind: string; name?: { value: string } };
      }>;
    }) => {
      if (node.name.value !== typeName) return undefined;
      for (const field of node.fields ?? []) {
        const scalar = field.type.kind === 'NamedType' && field.type.name ? field.type.name.value : '';
        if (field.name.value === '_version' && scalar === 'Int') found._version = true;
        if (field.name.value === '_deleted' && scalar === 'Boolean') found._deleted = true;
        if (field.name.value === '_lastChangedAt' && scalar === 'AWSTimestamp') found._lastChangedAt = true;
      }
      return undefined;
    },
  });
  return found._version && found._deleted && found._lastChangedAt;
};
/* eslint-enable no-underscore-dangle, @typescript-eslint/no-var-requires, global-require */

describe('injectSyncFields', () => {
  it('adds the three sync fields to a @model type that lacks them', () => {
    const schema = `
      type Todo @model {
        id: ID!
        title: String!
      }
    `;
    const result = injectSyncFields(schema);
    expect(result.modifiedModels).toEqual(['Todo']);
    expect(result.manyToManyRelations).toEqual([]);
    expect(hasAllSyncFields(result.updated, 'Todo')).toBe(true);
  });

  it('is idempotent — running twice yields the same output as once', () => {
    const schema = `
      type Todo @model {
        id: ID!
        title: String!
      }
    `;
    const once = injectSyncFields(schema);
    const twice = injectSyncFields(once.updated);
    expect(twice.updated).toBe(once.updated);
    expect(twice.modifiedModels).toEqual([]);
  });

  it('does not modify a @model that already declares all three fields', () => {
    const schema = `
      type Todo @model {
        id: ID!
        title: String!
        _version: Int
        _deleted: Boolean
        _lastChangedAt: AWSTimestamp
      }
    `;
    const result = injectSyncFields(schema);
    expect(result.modifiedModels).toEqual([]);
  });

  it('fills in missing fields when only some of the three are declared', () => {
    const schema = `
      type Todo @model {
        id: ID!
        title: String!
        _version: Int
      }
    `;
    const result = injectSyncFields(schema);
    expect(result.modifiedModels).toEqual(['Todo']);
    expect(hasAllSyncFields(result.updated, 'Todo')).toBe(true);
    const versionOccurrences = (result.updated.match(/_version/g) ?? []).length;
    expect(versionOccurrences).toBe(1);
  });

  it.each([
    ['_version only', 'type T @model { id: ID! _version: Int }'],
    ['_deleted only', 'type T @model { id: ID! _deleted: Boolean }'],
    ['_lastChangedAt only', 'type T @model { id: ID! _lastChangedAt: AWSTimestamp }'],
    ['_version + _deleted', 'type T @model { id: ID! _version: Int _deleted: Boolean }'],
    ['_version + _lastChangedAt', 'type T @model { id: ID! _version: Int _lastChangedAt: AWSTimestamp }'],
    ['_deleted + _lastChangedAt', 'type T @model { id: ID! _deleted: Boolean _lastChangedAt: AWSTimestamp }'],
  ])('handles mixed state: %s', (_, schema) => {
    const result = injectSyncFields(schema);
    expect(result.modifiedModels).toEqual(['T']);
    expect(hasAllSyncFields(result.updated, 'T')).toBe(true);
    for (const field of SYNC_FIELD_NAMES) {
      const count = (result.updated.match(new RegExp(`${field}:`, 'g')) ?? []).length;
      expect(count).toBe(1);
    }
  });

  it('ignores object types that are not annotated with @model', () => {
    const schema = `
      type Todo @model {
        id: ID!
      }
      type NotAModel {
        id: ID!
      }
    `;
    const result = injectSyncFields(schema);
    expect(result.modifiedModels).toEqual(['Todo']);
    expect(result.updated).not.toMatch(/type\s+NotAModel\s*\{[^}]*_version/s);
  });

  it('ignores enum and scalar definitions', () => {
    const schema = `
      enum Status { ACTIVE INACTIVE }
      scalar MyScalar
      type Todo @model { id: ID! }
    `;
    const result = injectSyncFields(schema);
    expect(result.modifiedModels).toEqual(['Todo']);
    expect(result.manyToManyRelations).toEqual([]);
  });

  it('tracks @manyToMany relations by relationName and enumerates source models', () => {
    const schema = `
      type Card @model {
        id: ID!
        title: String!
        labels: [Label] @manyToMany(relationName: "CardLabel")
      }
      type Label @model {
        id: ID!
        name: String!
        cards: [Card] @manyToMany(relationName: "CardLabel")
      }
    `;
    const result = injectSyncFields(schema);
    expect(result.modifiedModels.sort()).toEqual(['Card', 'Label']);
    expect(result.manyToManyRelations).toHaveLength(1);
    expect(result.manyToManyRelations[0].relationName).toBe('CardLabel');
    expect(result.manyToManyRelations[0].sourceModels).toEqual(['Card', 'Label']);
    expect(hasAllSyncFields(result.updated, 'Card')).toBe(true);
    expect(hasAllSyncFields(result.updated, 'Label')).toBe(true);
    expect(result.updated).not.toMatch(/type\s+CardLabel\b/);
  });

  it('tracks multiple distinct @manyToMany relations', () => {
    const schema = `
      type User @model { id: ID! }
      type Post @model {
        id: ID!
        tags: [Tag] @manyToMany(relationName: "PostTag")
        collaborators: [User] @manyToMany(relationName: "PostCollaborator")
      }
      type Tag @model {
        id: ID!
        posts: [Post] @manyToMany(relationName: "PostTag")
      }
    `;
    const result = injectSyncFields(schema);
    expect(result.manyToManyRelations.map((r) => r.relationName)).toEqual([
      'PostCollaborator',
      'PostTag',
    ]);
    expect(
      result.manyToManyRelations.find((r) => r.relationName === 'PostTag')?.sourceModels,
    ).toEqual(['Post', 'Tag']);
    expect(
      result.manyToManyRelations.find((r) => r.relationName === 'PostCollaborator')?.sourceModels,
    ).toEqual(['Post']);
  });

  it('preserves @auth, @hasMany, @belongsTo, and @index directives on other fields', () => {
    const schema = `
      type Board @model
        @auth(rules: [{ allow: owner, ownerField: "owner", identityClaim: "email" }]) {
        id: ID!
        name: String!
        owner: String
        workspaceID: ID! @index(name: "byWorkspace")
        columns: [Column] @hasMany(indexName: "byBoard", fields: ["id"])
      }
      type Column @model {
        id: ID!
        name: String!
        boardID: ID! @index(name: "byBoard")
        board: Board @belongsTo(fields: ["boardID"])
      }
    `;
    const result = injectSyncFields(schema);
    expect(result.modifiedModels.sort()).toEqual(['Board', 'Column']);
    expect(result.updated).toMatch(/@auth\(rules:/);
    expect(result.updated).toMatch(/@hasMany\(indexName: "byBoard"/);
    expect(result.updated).toMatch(/@belongsTo\(fields:/);
    expect(result.updated).toMatch(/@index\(name: "byBoard"\)/);
    expect(hasAllSyncFields(result.updated, 'Board')).toBe(true);
    expect(hasAllSyncFields(result.updated, 'Column')).toBe(true);
  });

  it('uses correct scalar types: Int, Boolean, AWSTimestamp', () => {
    const schema = 'type Todo @model { id: ID! }';
    const result = injectSyncFields(schema);
    expect(result.updated).toMatch(/_version:\s*Int\b/);
    expect(result.updated).toMatch(/_deleted:\s*Boolean\b/);
    expect(result.updated).toMatch(/_lastChangedAt:\s*AWSTimestamp\b/);
  });

  it('returns empty lists for a schema with no @model types', () => {
    const schema = `
      type NotAModel {
        id: ID!
      }
      enum Status {
        ACTIVE
        INACTIVE
      }
    `;
    const result = injectSyncFields(schema);
    expect(result.modifiedModels).toEqual([]);
    expect(result.manyToManyRelations).toEqual([]);
  });

  it('throws on syntactically invalid SDL (caller expected to catch)', () => {
    expect(() => injectSyncFields('type Broken @model { id: ID!')).toThrow();
  });
});

describe('buildMigrationChecklist', () => {
  it('produces an info line saying no changes when nothing was modified and no m2m', () => {
    const lines = buildMigrationChecklist({
      modifiedModels: [],
      manyToManyRelations: [],
      colored: false,
    });
    const infoLines = lines.filter((l) => l.level === 'info').map((l) => l.message);
    expect(infoLines.join('\n')).toMatch(/already declare _version/);
    const allText = lines.map((l) => l.message).join('\n');
    expect(allText).toContain('delete<Model> mutations become HARD deletes');
    expect(allText).toContain('sync<Model> queries and observeQuery subscriptions no longer exist');
    expect(allText).toContain(MIGRATION_GUIDE_URL);
  });

  it('lists every modified model as a separate info line', () => {
    const lines = buildMigrationChecklist({
      modifiedModels: ['User', 'Board', 'Card'],
      manyToManyRelations: [],
      colored: false,
    });
    const text = lines.map((l) => l.message).join('\n');
    expect(text).toContain('Injected _version: Int, _deleted: Boolean, _lastChangedAt: AWSTimestamp into 3 @model types');
    expect(text).toContain('  • User');
    expect(text).toContain('  • Board');
    expect(text).toContain('  • Card');
  });

  it('enumerates manyToMany relations with join type name and source models', () => {
    const lines = buildMigrationChecklist({
      modifiedModels: ['Card', 'Label'],
      manyToManyRelations: [
        { relationName: 'CardLabel', sourceModels: ['Card', 'Label'] },
      ],
      colored: false,
    });
    const text = lines.map((l) => l.message).join('\n');
    expect(text).toContain('CardLabel  (from Card ↔ Label)');
    expect(text).toContain('synthesized by the transformer');
    expect(text).toContain('DeleteItem where _deleted == true');
  });

  it('uses singular "type" when exactly one model was modified', () => {
    const lines = buildMigrationChecklist({
      modifiedModels: ['Todo'],
      manyToManyRelations: [],
      colored: false,
    });
    const text = lines.map((l) => l.message).join('\n');
    expect(text).toMatch(/1 @model type:$/m);
  });

  it('does not include ANSI escapes when colored: false', () => {
    const lines = buildMigrationChecklist({
      modifiedModels: ['Todo'],
      manyToManyRelations: [],
      colored: false,
    });
    for (const line of lines) {
      // \u001b is ESC, start of ANSI escape sequences
      // eslint-disable-next-line no-control-regex
      expect(line.message).not.toMatch(/\u001b\[/);
    }
  });
});
