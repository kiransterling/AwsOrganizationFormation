import { Organizations } from 'aws-sdk';
import { Command } from 'commander';
import { AwsUtil } from '../util/aws-util';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../org-formation-error';
import { AwsOrganization } from '~aws-provider/aws-organization';
import { AwsOrganizationReader } from '~aws-provider/aws-organization-reader';
import { AwsOrganizationWriter } from '~aws-provider/aws-organization-writer';
import { OrganizationBinder } from '~org-binder/org-binder';
import { TaskProvider } from '~org-binder/org-tasks-provider';
import { TemplateRoot } from '~parser/parser';
import { PersistedState } from '~state/persisted-state';
import { S3StorageProvider } from '~state/storage-provider';
import { DefaultTemplate, DefaultTemplateWriter } from '~writer/default-template-writer';
import { CfnParameters } from '~core/cfn-parameters';


export abstract class BaseCliCommand<T extends ICommandArgs> {

    protected command: Command;
    protected firstArg: any;

    constructor(command?: Command, name?: string, description?: string, firstArgName?: string) {
        if (command !== undefined && name !== undefined) {
            this.command = command.command(name);
            if (description !== undefined) {
                this.command.description(description);
            }
            this.command.allowUnknownOption(false);
            this.addOptions(this.command);
            this.command.action(async (firstArg: string) => {
                if (firstArgName && (typeof firstArg !== 'object')) {
                    this.command[firstArgName] = firstArg;
                }
                this.invoke();
            });
        }
    }

    public async generateDefaultTemplate(): Promise<DefaultTemplate> {

        const organizations = new Organizations({ region: 'us-east-1' });
        const awsReader = new AwsOrganizationReader(organizations);
        const awsOrganization = new AwsOrganization(awsReader);
        const writer = new DefaultTemplateWriter(awsOrganization);
        const template = await writer.generateDefaultTemplate();
        template.template = template.template.replace(/( *)-\n\1 {2}/g, '$1- ');
        const parsedTemplate = TemplateRoot.createFromContents(template.template, './');
        template.state.setPreviousTemplate(parsedTemplate.source);
        return template;
    }

    public async getState(command: ICommandArgs): Promise<PersistedState> {
        if (command.state) {
            return command.state;
        }
        const storageProvider = await this.getStateBucket(command);
        const accountId = await AwsUtil.GetMasterAccountId();

        try {
            const state = await PersistedState.Load(storageProvider, accountId);
            command.state = state;
            return state;
        } catch (err) {
            if (err && err.code === 'NoSuchBucket') {
                throw new OrgFormationError(`unable to load previously committed state, reason: bucket '${storageProvider.bucketName}' does not exist in current account.`);
            }
            throw err;
        }
    }

    public async invoke(): Promise<void> {
        try {
            await this.initialize(this.command as any as ICommandArgs);
            await this.performCommand(this.command as any as T);
        } catch (err) {
            if (err instanceof OrgFormationError) {
                ConsoleUtil.LogError(err.message);
            } else {
                if (err.code && err.requestId) {
                    ConsoleUtil.LogError(`error: ${err.code}, aws-request-id: ${err.requestId}`);
                    ConsoleUtil.LogError(err.message);

                } else {
                    ConsoleUtil.LogError('unexpected error occurred...', err);
                }
            }
            process.exitCode = 1;
        }
    }
    protected abstract async performCommand(command: T): Promise<void>;

    protected addOptions(command: Command): void {
        command.option('--state-bucket-name [state-bucket-name]', 'bucket name that contains state file', 'organization-formation-${AWS::AccountId}');
        command.option('--state-object [state-object]', 'key for object used to store state', 'state.json');
        command.option('--profile [profile]', 'aws profile to use');
        command.option('--print-stack', 'will print stack traces for errors');
        command.option('--verbose', 'will enable debug logging');
        command.option('--no-color', 'will disable colorization of console logs');
    }

    protected async getOrganizationBinder(template: TemplateRoot, state: PersistedState): Promise<OrganizationBinder> {
        const organizations = new Organizations({ region: 'us-east-1' });
        const awsReader = new AwsOrganizationReader(organizations);
        const awsOrganization = new AwsOrganization(awsReader);
        await awsOrganization.initialize();
        const awsWriter = new AwsOrganizationWriter(organizations, awsOrganization);
        const taskProvider = new TaskProvider(template, state, awsWriter);
        const binder = new OrganizationBinder(template, state, taskProvider);
        return binder;
    }

    protected async createOrGetStateBucket(command: ICommandArgs, region: string): Promise<S3StorageProvider> {
        const storageProvider = await this.getStateBucket(command);
        try {
            await storageProvider.create(region);
        } catch (err) {
            if (err && err.code === 'BucketAlreadyOwnedByYou') {
                return storageProvider;
            }
            throw err;
        }
        return storageProvider;
    }

    protected async getStateBucket(command: ICommandArgs): Promise<S3StorageProvider> {
        const objectKey = command.stateObject;
        const stateBucketName = await this.GetStateBucketName(command);
        const storageProvider = await S3StorageProvider.Create(stateBucketName, objectKey);
        return storageProvider;
    }

    protected async GetStateBucketName(command: ICommandArgs): Promise<string> {
        const bucketName = command.stateBucketName || 'organization-formation-${AWS::AccountId}';
        if (bucketName.indexOf('${AWS::AccountId}') >= 0) {
            const accountId = await AwsUtil.GetMasterAccountId();
            return bucketName.replace('${AWS::AccountId}', accountId);
        }
        return bucketName;
    }

    protected parseCfnParameters(commandParameters?: string | undefined | {}): Record<string, string>  {

        if (typeof commandParameters === 'object') {
            return commandParameters;
        }
        if (typeof commandParameters === 'string') {
            return CfnParameters.ParseParameterValues(commandParameters);
        }

        return {};
    }

    protected async initialize(command: ICommandArgs): Promise<void> {
        if (command.initialized) { return; }

        if (command.printStack === true) {
            ConsoleUtil.printStacktraces = true;
        }
        if (command.verbose === true) {
            ConsoleUtil.verbose = true;
        }
        if (command.color === false) {
            ConsoleUtil.colorizeLogs = false;
        }

        // create a copy of `command` to ensure no circular references
        ConsoleUtil.LogDebug(`initializing, arguments: \n${JSON.stringify({

            stateBucketName: command.stateBucketName,
            stateObject: command.stateObject,
            state: typeof command.state,
            profile: command.profile,
            color: command.color,
            verbose: command.verbose,
            printStack: command.printStack,
        }, undefined, 2)}`);

        await AwsUtil.InitializeWithProfile(command.profile);

        command.initialized = true;
    }
}

export interface ICommandArgs {
    stateBucketName: string;
    stateObject: string;
    profile?: string;
    state?: PersistedState;
    initialized?: boolean;
    printStack?: boolean;
    verbose?: boolean;
    color?: boolean;
}
