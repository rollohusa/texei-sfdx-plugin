import { flags, SfdxCommand } from "@salesforce/command";
import { Messages } from '@salesforce/core';
import { StandardValueSetHelper } from "../../../../shared/standardValueSetHelper";

// Initialize Messages with the current plugin directory
Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = Messages.loadMessages(
  "texei-sfdx-plugin",
  "contractstatus-value-add"
);

export default class Add extends SfdxCommand {
  public static description = messages.getMessage("commandDescription");

  public static examples = [
    `sfdx texei:contractstatus:value:add --label 'My New Contract Status Label' --apiname 'My New Contract Status API Name' --targetusername texei`,
  ];

  protected static flagsConfig = {
    label: flags.string({char: 'l', description: messages.getMessage('labelFlagDescription'), required: true}),
    apiname: flags.string({char: 'a', description: messages.getMessage('apiNameFlagDescription'), required: true}),
    statuscategory: flags.string({char: 's', description: messages.getMessage('statusCategoryFlagDescription'), options: ['Draft','Activated','InApprovalProcess'], default: 'Draft', required: false})
  };

  // Comment this out if your command does not require an org username
  protected static requiresUsername = true;

  // Comment this out if your command does not support a hub org username
  protected static requiresDevhubUsername = false;

  // Set this to true if your command requires a project workspace; 'requiresProject' is false by default
  protected static requiresProject = false;

  public async run(): Promise<any> {

    this.ux.warn('ContractStatus StandardValueSet is now supported, you should move to the Metadata API instead of using this command.');
    
    this.ux.startSpinner(`Adding ContractStatus value (${this.flags.label}/${this.flags.apiname})`, null, { stdout: true });

    const svsh = new StandardValueSetHelper(this.org.getConnection(), 'ContractStatus');
    await svsh.addValue(this.flags.label, this.flags.apiname, this.flags.statuscategory);
    await svsh.close();

    this.ux.stopSpinner('Done.');

    return { message: `ContractStatus value added` };
  }
}