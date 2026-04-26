import * as path from 'path';
import {
  $TSContext,
  AmplifyError,
  AmplifySupportedService,
  isResourceNameUnique,
  JSONUtilities,
  pathManager,
  stateManager,
} from '@aws-amplify/amplify-cli-core';
import {
  AddApiRequest,
  AppSyncServiceConfiguration,
  AppSyncServiceModification,
  ConflictResolution,
  ResolutionStrategy,
  UpdateApiRequest,
} from 'amplify-headless-interface';
import { printer } from '@aws-amplify/amplify-prompts';
import * as fs from 'fs-extra';
import { readTransformerConfiguration, TRANSFORM_CURRENT_VERSION, writeTransformerConfiguration } from 'graphql-transformer-core';
import _ from 'lodash';
import { v4 as uuid } from 'uuid';
import { category } from '../../category-constants';
import { ApiArtifactHandler, ApiArtifactHandlerOptions } from '../api-artifact-handler';
import { AppsyncApiInputState } from './api-input-manager/appsync-api-input-state';
import { cfnParametersFilename, gqlSchemaFilename, provider, rootAssetDir } from './aws-constants';
import { AppSyncCLIInputs, AppSyncServiceConfig } from './service-walkthrough-types/appsync-user-input-types';
import { authConfigHasApiKey, checkIfAuthExists, getAppSyncAuthConfig, getAppSyncResourceName } from './utils/amplify-meta-utils';
import { appSyncAuthTypeToAuthConfig } from './utils/auth-config-to-app-sync-auth-type-bi-di-mapper';
import { printApiKeyWarnings } from './utils/print-api-key-warnings';
import { conflictResolutionToResolverConfig } from './utils/resolver-config-to-conflict-resolution-bi-di-mapper';
import { injectSyncFields } from './helpers/preserve-sync-fields';
import chalk from 'chalk';

// keep in sync with ServiceName in amplify-category-function, but probably it will not change
const FunctionServiceNameLambdaFunction = 'Lambda';

/**
 * Factory function that returns an ApiArtifactHandler instance
 */
export const getCfnApiArtifactHandler = (context: $TSContext): ApiArtifactHandler => new CfnApiArtifactHandler(context);

const resolversDirName = 'resolvers';
const stacksDirName = 'stacks';
const defaultStackName = 'CustomResources.json';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const defaultCfnParameters = (apiName: string) => ({
  AppSyncApiName: apiName,
  DynamoDBBillingMode: 'PAY_PER_REQUEST',
  DynamoDBEnableServerSideEncryption: false,
});
class CfnApiArtifactHandler implements ApiArtifactHandler {
  private readonly context: $TSContext;

  constructor(context: $TSContext) {
    this.context = context;
  }

  // TODO once the AddApiRequest contains multiple services this class should depend on an ApiArtifactHandler
  // for each service and delegate to the correct one
  createArtifacts = async (request: AddApiRequest): Promise<string> => {
    const meta = stateManager.getMeta();
    const existingApiName = getAppSyncResourceName(meta);
    if (existingApiName) {
      throw new AmplifyError('ResourceAlreadyExistsError', {
        message: `GraphQL API ${existingApiName} already exists in the project`,
        resolution: 'Use amplify update api to make modifications',
      });
    }
    const serviceConfig = request.serviceConfiguration;

    isResourceNameUnique('api', serviceConfig.apiName);

    const resourceDir = this.getResourceDir(serviceConfig.apiName);

    // Ensure the project directory exists and create the stacks & resolvers directories.
    fs.ensureDirSync(resourceDir);
    const resolverDirectoryPath = path.join(resourceDir, resolversDirName);
    if (!fs.existsSync(resolverDirectoryPath)) {
      fs.mkdirSync(resolverDirectoryPath);
    }
    const stacksDirectoryPath = path.join(resourceDir, stacksDirName);
    if (!fs.existsSync(stacksDirectoryPath)) {
      fs.mkdirSync(stacksDirectoryPath);
      fs.copyFileSync(path.join(rootAssetDir, 'resolver-readme', 'RESOLVER_README.md'), path.join(resolverDirectoryPath, 'README.md'));
    }

    // During API add, make sure we're creating a transform.conf.json file with the latest version the CLI supports.
    await this.updateTransformerConfigVersion(resourceDir);

    serviceConfig.conflictResolution = await this.createResolverResources(serviceConfig.conflictResolution);
    await writeResolverConfig(serviceConfig.conflictResolution, resourceDir);

    const appsyncCLIInputs = await this.generateAppsyncCLIInputs(serviceConfig);

    // Write the default custom resources stack out to disk.
    fs.copyFileSync(
      path.join(rootAssetDir, 'cloudformation-templates', 'defaultCustomResources.json'),
      path.join(resourceDir, stacksDirName, defaultStackName),
    );

    const authConfig = this.extractAuthConfig(appsyncCLIInputs.serviceConfiguration);
    const dependsOn = amendDependsOnForAuthConfig([], authConfig);
    const apiParameters = this.getCfnParameters(serviceConfig.apiName, authConfig, resourceDir);
    this.ensureCfnParametersExist(resourceDir, apiParameters);
    this.context.amplify.updateamplifyMetaAfterResourceAdd(category, serviceConfig.apiName, this.createAmplifyMeta(authConfig, dependsOn));

    if (serviceConfig?.transformSchema) {
      // write the template buffer to the project folder
      this.writeSchema(path.join(resourceDir, gqlSchemaFilename), serviceConfig.transformSchema);

      await this.context.amplify.executeProviderUtils(this.context, 'awscloudformation', 'compileSchema', {
        resourceDir,
        parameters: apiParameters,
        authConfig,
      });
    }

    return serviceConfig.apiName;
  };

  // TODO once the AddApiRequest contains multiple services this class should depend on an ApiArtifactHandler
  // for each service and delegate to the correct one
  updateArtifacts = async (request: UpdateApiRequest, opts?: ApiArtifactHandlerOptions): Promise<void> => {
    const updates = request.serviceModification;
    const apiName = getAppSyncResourceName(stateManager.getMeta());
    if (!apiName) {
      throw new AmplifyError('NotImplementedError', {
        message: `${AmplifySupportedService.APPSYNC} API does not exist`,
        resolution: "To add an api, use 'amplify add api'",
      });
    }
    const resourceDir = this.getResourceDir(apiName);

    // Because we rely on an in-place update for 'NEW' lambda conflictResolution types, we
    // execute this behavior before the call to `updateAppsyncCLIInputs`.
    if (updates.conflictResolution) {
      // Detect a "disable conflict resolution" request: payload has an empty
      // or default-strategy-less `conflictResolution` AND the existing project
      // state currently HAS a ResolverConfig. Mirror the interactive DISABLE_CONFLICT
      // arm by pre-injecting _version/_deleted/_lastChangedAt into every @model in
      // schema.graphql before the transformer strips them on the next push.
      // The caller can opt out by passing `preserveSyncFields: false` in the payload.
      const isDisablingConflict =
        !updates.conflictResolution.defaultResolutionStrategy &&
        _.isEmpty(updates.conflictResolution.perModelResolutionStrategy);
      const preserveSyncFields =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (updates.conflictResolution as any).preserveSyncFields !== false;
      if (isDisablingConflict && preserveSyncFields) {
        await this.preserveSyncFieldsOnDisable(resourceDir);
      }
      // Strip the non-standard flag before downstream consumers see it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (updates.conflictResolution as any).preserveSyncFields;

      updates.conflictResolution = await this.createResolverResources(updates.conflictResolution);
      await writeResolverConfig(updates.conflictResolution, resourceDir);
    }

    // update appsync cli-inputs
    const gqlSchemaPath = await this.updateAppsyncCLIInputs(updates, apiName);
    if (updates.transformSchema) {
      this.writeSchema(gqlSchemaPath, updates.transformSchema);
    }

    const authConfig = getAppSyncAuthConfig(stateManager.getMeta());
    const previousAuthConfig = _.cloneDeep(authConfig);
    const oldConfigHadApiKey = authConfigHasApiKey(authConfig);
    if (updates.defaultAuthType) {
      authConfig.defaultAuthentication = appSyncAuthTypeToAuthConfig(updates.defaultAuthType);
    }
    if (updates.additionalAuthTypes) {
      authConfig.additionalAuthenticationProviders = updates.additionalAuthTypes.map(appSyncAuthTypeToAuthConfig);
    }

    if (!opts?.skipCompile) {
      await this.context.amplify.executeProviderUtils(this.context, 'awscloudformation', 'compileSchema', {
        resourceDir,
        parameters: this.getCfnParameters(apiName, authConfig, resourceDir),
        authConfig,
        previousAuthConfig,
      });
    }

    this.context.amplify.updateamplifyMetaAfterResourceUpdate(category, apiName, 'output', { authConfig });
    this.context.amplify.updateBackendConfigAfterResourceUpdate(category, apiName, 'output', { authConfig });

    const existingDependsOn = stateManager.getBackendConfig()?.[category]?.[apiName]?.dependsOn || [];
    const newDependsOn = amendDependsOnForAuthConfig(existingDependsOn, authConfig);
    this.context.amplify.updateBackendConfigAfterResourceUpdate(category, apiName, 'dependsOn', newDependsOn);
    this.context.amplify.updateamplifyMetaAfterResourceUpdate(category, apiName, 'dependsOn', newDependsOn);

    printApiKeyWarnings(oldConfigHadApiKey, authConfigHasApiKey(authConfig));
  };

  private writeSchema = (resourceDir: string, schema: string): void => {
    fs.writeFileSync(resourceDir, schema);
  };

  /**
   * Before disabling conflict resolution (removing it from transform.conf.json),
   * mutate the user's `schema.graphql` so every `@model` declares the three
   * DataStore metadata fields (`_version`, `_deleted`, `_lastChangedAt`) as
   * regular user fields. Otherwise the transformer will strip those fields
   * from the generated AppSync schema on the next push, and any frontend code
   * still sending them in mutation inputs will fail with a GraphQL validation
   * error.
   *
   * See: https://github.com/aws-amplify/docs/pull/8578
   */
  private preserveSyncFieldsOnDisable = async (resourceDir: string): Promise<void> => {
    const schemaPath = path.join(resourceDir, 'schema.graphql');
    if (!(await fs.pathExists(schemaPath))) {
      printer.warn(
        `preserveSyncFields: no schema.graphql at ${schemaPath} — skipping metadata field injection. ` +
          `If you use the split schema/ directory layout you will need to add _version/_deleted/_lastChangedAt manually.`,
      );
      return;
    }

    const original = (await fs.readFile(schemaPath)).toString();
    const { updated, modifiedModels, manyToManyModels } = injectSyncFields(original);

    if (modifiedModels.length === 0) {
      printer.info('All @model types already declare _version / _deleted / _lastChangedAt — no schema changes needed.');
    } else {
      await fs.writeFile(schemaPath, updated);
      printer.info(
        chalk.cyan(
          `Injected _version: Int, _deleted: Boolean, _lastChangedAt: AWSTimestamp into ${modifiedModels.length} ` +
            `@model type${modifiedModels.length === 1 ? '' : 's'}:`,
        ),
      );
      modifiedModels.forEach((name) => printer.info(`  • ${name}`));
    }

    printer.warn('');
    printer.warn(chalk.yellow.bold('⚠  DataStore → AppSync migration checklist'));
    printer.warn(chalk.yellow('   Disabling conflict detection is a breaking change for any code using `DataStore.*`.'));
    printer.warn('');

    if (manyToManyModels.length > 0) {
      printer.warn(
        chalk.yellow.bold('   @manyToMany join types NOT modified (auto-synthesized, not in schema.graphql):'),
      );
      manyToManyModels.forEach((name) => printer.warn(chalk.yellow(`     • ${name}`)));
      printer.warn(
        chalk.yellow(
          '   Soft-deleted rows in join tables will linger in DynamoDB after disable. A one-time ' +
            'cleanup pass is recommended — see migration guide below.',
        ),
      );
      printer.warn('');
    }

    printer.warn(chalk.yellow.bold('   Runtime behaviour changes you must handle in your app:'));
    printer.warn(chalk.yellow('     • `delete*` mutations become HARD deletes (row is removed from DynamoDB).'));
    printer.warn(chalk.yellow('       Any UI that relied on `_deleted: true` soft-deletes will silently stop working.'));
    printer.warn(chalk.yellow('     • `_version` is NO LONGER auto-incremented by the AppSync resolver.'));
    printer.warn(chalk.yellow('       Mutations now accept the field but the value is meaningless.'));
    printer.warn(
      chalk.yellow(
        '     • `sync*` queries and `observeQuery` subscriptions are GONE — migrate to `list*` + `onCreate*`/`onUpdate*`/`onDelete*`.',
      ),
    );
    printer.warn('');
    printer.warn(chalk.yellow('   Migration guide: https://github.com/aws-amplify/docs/pull/8578'));
    printer.warn('');
  };

  private getResourceDir = (apiName: string): string => pathManager.getResourceDirectoryPath(undefined, category, apiName);

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  private createAmplifyMeta = (authConfig: AuthConfig, dependsOn?: DependsOnEntry[]) => ({
    service: 'AppSync',
    providerPlugin: provider,
    dependsOn,
    output: {
      authConfig,
    },
  });

  private extractAuthConfig = (config: AppSyncServiceConfig): AuthConfig => ({
    defaultAuthentication: appSyncAuthTypeToAuthConfig(config.defaultAuthType),
    additionalAuthenticationProviders: (config.additionalAuthTypes || []).map(appSyncAuthTypeToAuthConfig),
  });

  private updateTransformerConfigVersion = async (resourceDir: string): Promise<void> => {
    const localTransformerConfig = await readTransformerConfiguration(resourceDir);
    localTransformerConfig.Version = TRANSFORM_CURRENT_VERSION;
    localTransformerConfig.ElasticsearchWarning = true;
    await writeTransformerConfiguration(resourceDir, localTransformerConfig);
  };

  private createResolverResources = async (conflictResolution: ConflictResolution = {}): Promise<ConflictResolution> => {
    const newConflictResolution = _.cloneDeep(conflictResolution);

    // if the strategy is a new lambda, generate the lambda and update the strategy to reference the new lambda
    const generateLambdaIfNew = async (strategy: ResolutionStrategy): Promise<void> => {
      if (strategy && strategy.type === 'LAMBDA' && strategy.resolver.type === 'NEW') {
        // eslint-disable-next-line no-param-reassign
        strategy.resolver = {
          type: 'EXISTING',
          name: await this.createSyncFunction(),
        };
      }
    };
    await generateLambdaIfNew(newConflictResolution.defaultResolutionStrategy);
    await Promise.all(
      (newConflictResolution.perModelResolutionStrategy || [])
        .map((perModelStrategy) => perModelStrategy.resolutionStrategy)
        .map(generateLambdaIfNew),
    );
    return newConflictResolution;
  };

  private getCfnParameters = (apiName: string, authConfig, resourceDir: string): Record<string, unknown> => {
    const cfnPath = path.join(resourceDir, cfnParametersFilename);
    const params = JSONUtilities.readJson<any>(cfnPath, { throwIfNotExist: false }) || defaultCfnParameters(apiName);
    const cognitoPool = this.getCognitoUserPool(authConfig);
    if (cognitoPool) {
      params.AuthCognitoUserPoolId = cognitoPool;
    } else {
      delete params.AuthCognitoUserPoolId;
    }
    return params;
  };

  private getCognitoUserPool = (authConfig: AuthConfig): Record<string, unknown> | undefined => {
    const additionalUserPoolProvider = (authConfig.additionalAuthenticationProviders || []).find(
      (aap) => aap.authenticationType === 'AMAZON_COGNITO_USER_POOLS',
    );
    const defaultAuth = authConfig.defaultAuthentication;
    if (!(defaultAuth?.authenticationType === 'AMAZON_COGNITO_USER_POOLS') && !additionalUserPoolProvider) {
      return undefined;
    }
    let userPoolId;
    const configuredUserPoolName = checkIfAuthExists();

    if (authConfig.userPoolConfig) {
      ({ userPoolId } = authConfig.userPoolConfig);
    } else if (additionalUserPoolProvider && additionalUserPoolProvider.userPoolConfig) {
      ({ userPoolId } = additionalUserPoolProvider.userPoolConfig);
    } else if (configuredUserPoolName) {
      userPoolId = `auth${configuredUserPoolName}`;
    } else {
      throw new Error('Cannot find a configured Cognito User Pool.');
    }

    return {
      'Fn::GetAtt': [userPoolId, 'Outputs.UserPoolId'],
    };
  };

  private createSyncFunction = async (): Promise<string> => {
    const targetDir = pathManager.getBackendDirPath();
    const assetDir = path.normalize(path.join(rootAssetDir, 'sync-conflict-handler'));
    const [shortId] = uuid().split('-');

    const functionName = `syncConflictHandler${shortId}`;

    const functionProps = {
      functionName: `${functionName}`,
      roleName: `${functionName}LambdaRole`,
    };

    const copyJobs = [
      {
        dir: assetDir,
        template: 'sync-conflict-handler-index.js.ejs',
        target: path.join(targetDir, 'function', functionName, 'src', 'index.js'),
      },
      {
        dir: assetDir,
        template: 'sync-conflict-handler-package.json.ejs',
        target: path.join(targetDir, 'function', functionName, 'src', 'package.json'),
      },
      {
        dir: assetDir,
        template: 'sync-conflict-handler-template.json.ejs',
        target: path.join(targetDir, 'function', functionName, `${functionName}-cloudformation-template.json`),
      },
    ];

    // copy over the files
    await this.context.amplify.copyBatch(this.context, copyJobs, functionProps, true);

    const backendConfigs = {
      service: FunctionServiceNameLambdaFunction,
      providerPlugin: provider,
      build: true,
    };

    await this.context.amplify.updateamplifyMetaAfterResourceAdd('function', functionName, backendConfigs);
    printer.success(`Successfully added ${functionName} function locally`);

    return `${functionName}-\${env}`;
  };

  private generateAppsyncCLIInputs = async (serviceConfig: AppSyncServiceConfiguration): Promise<AppSyncCLIInputs> => {
    const appsyncCLIInputs: AppSyncCLIInputs = {
      version: 1,
      serviceConfiguration: {
        apiName: serviceConfig.apiName,
        serviceName: serviceConfig.serviceName,
        defaultAuthType: serviceConfig.defaultAuthType,
      },
    };
    if (!_.isEmpty(serviceConfig.additionalAuthTypes)) {
      appsyncCLIInputs.serviceConfiguration.additionalAuthTypes = serviceConfig.additionalAuthTypes;
    }

    if (!_.isEmpty(serviceConfig.conflictResolution)) {
      appsyncCLIInputs.serviceConfiguration.conflictResolution = {
        defaultResolutionStrategy: serviceConfig.conflictResolution.defaultResolutionStrategy,
        perModelResolutionStrategy: serviceConfig.conflictResolution.perModelResolutionStrategy,
      };
    }
    // deploy appsync inputs
    const cliState = new AppsyncApiInputState(this.context, serviceConfig.apiName);
    await cliState.saveCLIInputPayload(appsyncCLIInputs);
    return appsyncCLIInputs;
  };

  private updateAppsyncCLIInputs = async (updates: AppSyncServiceModification, apiName: string) => {
    const cliState = new AppsyncApiInputState(this.context, apiName);
    const gqlSchemaPath = path.join(this.getResourceDir(apiName), gqlSchemaFilename);
    if (!cliState.cliInputFileExists()) {
      return gqlSchemaPath;
    }
    const prevAppsyncInputs = cliState.getCLIInputPayload();

    const appsyncInputs: AppSyncCLIInputs = prevAppsyncInputs;
    if ((appsyncInputs.serviceConfiguration as any)?.gqlSchemaPath) {
      delete (appsyncInputs.serviceConfiguration as any).gqlSchemaPath;
    }
    if (updates.conflictResolution) {
      appsyncInputs.serviceConfiguration.conflictResolution = updates.conflictResolution;
    }
    if (updates.defaultAuthType) {
      appsyncInputs.serviceConfiguration.defaultAuthType = updates.defaultAuthType;
    }
    if (updates.additionalAuthTypes) {
      appsyncInputs.serviceConfiguration.additionalAuthTypes = updates.additionalAuthTypes;
    }
    await cliState.saveCLIInputPayload(appsyncInputs);
    return gqlSchemaPath;
  };

  private ensureCfnParametersExist = (resourceDir: string, parameters: Record<string, unknown>) => {
    const parametersFilePath = path.join(resourceDir, cfnParametersFilename);
    if (!fs.existsSync(parametersFilePath)) {
      JSONUtilities.writeJson(parametersFilePath, parameters);
    }
  };
}

/**
 * This function is defined outside of the class because REST API generation uses it outside of the class above
 * Long-term, the class above should be extended to also include REST API generation
 *
 * write to the transformer conf if the resolverConfig is valid
 */
export const writeResolverConfig = async (conflictResolution: ConflictResolution, resourceDir: string): Promise<void> => {
  const localTransformerConfig = await readTransformerConfiguration(resourceDir);
  localTransformerConfig.ResolverConfig = conflictResolutionToResolverConfig(conflictResolution);
  await writeTransformerConfiguration(resourceDir, localTransformerConfig);
};

const amendDependsOnForAuthConfig = (currentDependsOn: DependsOnEntry[], authConfig: AuthConfig): DependsOnEntry[] => {
  if (hasCognitoAuthMode(authConfig)) {
    return ensureDependsOnAuth(currentDependsOn);
  }
  return ensureNoDependsOnAuth(currentDependsOn);
};

const hasCognitoAuthMode = (authConfig: AuthConfig): boolean =>
  authConfig?.defaultAuthentication?.authenticationType === 'AMAZON_COGNITO_USER_POOLS' ||
  authConfig?.additionalAuthenticationProviders?.find((aap) => aap.authenticationType === 'AMAZON_COGNITO_USER_POOLS') !== undefined;

// returns a new dependsOn array that has a single depends on auth block
const ensureDependsOnAuth = (currentDependsOn: DependsOnEntry[]): DependsOnEntry[] => {
  const authResourceName = checkIfAuthExists();
  if (!authResourceName) {
    return [];
  }
  // if dependency already exists, don't add it again
  if (currentDependsOn.find((dep) => dep.category === 'auth' && dep.resourceName === authResourceName)) {
    return currentDependsOn;
  }
  return currentDependsOn.concat({
    category: 'auth',
    resourceName: authResourceName,
    attributes: ['UserPoolId'],
  });
};

// returns a new dependsOn array that does not have a depends on auth block
const ensureNoDependsOnAuth = (currentDependsOn: DependsOnEntry[]): DependsOnEntry[] => {
  const authResourceName = checkIfAuthExists();
  if (!authResourceName) {
    return currentDependsOn;
  }
  const authIdx = currentDependsOn.findIndex((dep) => dep.category === 'auth' && dep.resourceName === authResourceName);
  if (authIdx < 0) {
    return currentDependsOn;
  }
  const newDependsOn = Array.from(currentDependsOn);
  newDependsOn.splice(authIdx, 1);
  return newDependsOn;
};

type DependsOnEntry = {
  category: string;
  resourceName: string;
  attributes: string[];
};

type AuthConfig = {
  defaultAuthentication?: AuthType;
  additionalAuthenticationProviders?: (AuthType & UserPoolConfig)[];
} & UserPoolConfig;

type UserPoolConfig = {
  userPoolConfig?: {
    userPoolId: string;
  };
};

type AuthType = {
  authenticationType: string;
};
