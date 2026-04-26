import { injectSyncFields } from '../../provider-utils/awscloudformation/helpers/preserve-sync-fields';

/**
 * Helper that asserts the three sync fields are present on a given @model
 * type in the printed schema. Parses and walks the AST so directive
 * braces (e.g., `@auth(rules: [{...}])`) don't confuse naive regex matching.
 */
const hasAllSyncFields = (schema: string, typeName: string): boolean => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parse, visit } = require('graphql');
  const ast = parse(schema, { noLocation: true });
  let found = { _version: false, _deleted: false, _lastChangedAt: false };
  visit(ast, {
    ObjectTypeDefinition(node: { name: { value: string }; fields?: ReadonlyArray<{ name: { value: string }; type: { kind: string; name?: { value: string } } }> }) {
      if (node.name.value !== typeName) return undefined;
      for (const field of node.fields ?? []) {
        const typeName =
          field.type.kind === 'NamedType' && field.type.name ? field.type.name.value : '';
        if (field.name.value === '_version' && typeName === 'Int') found._version = true;
        if (field.name.value === '_deleted' && typeName === 'Boolean') found._deleted = true;
        if (field.name.value === '_lastChangedAt' && typeName === 'AWSTimestamp') found._lastChangedAt = true;
      }
      return undefined;
    },
  });
  return found._version && found._deleted && found._lastChangedAt;
};

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
    expect(result.manyToManyModels).toEqual([]);
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

  it('tracks manyToMany source models separately (does NOT inject into the synthesized join type)', () => {
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
    expect(result.manyToManyModels.sort()).toEqual(['Card', 'Label']);
    expect(hasAllSyncFields(result.updated, 'Card')).toBe(true);
    expect(hasAllSyncFields(result.updated, 'Label')).toBe(true);
    expect(result.updated).not.toMatch(/type\s+CardLabel\b/);
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
    const schema = `type Todo @model { id: ID! }`;
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
    expect(result.manyToManyModels).toEqual([]);
  });
});
