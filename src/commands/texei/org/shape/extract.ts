import { SfdxCommand, flags } from '@salesforce/command';
import { Messages, SfdxError } from '@salesforce/core';
import * as fs from 'fs';
import * as path from 'path';
import { toTitleCase } from "../../../../shared/utils";

// Initialize Messages with the current plugin directory
Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = Messages.loadMessages('texei-sfdx-plugin', 'org-shape-extract');

const definitionFileName  = 'project-scratch-def.json';
// TODO: Add bypassed values in the correct array, and after investigation either fix or update org-shape-extract.md doc
const settingValuesProdOnly = ['Packaging2','ExpandedSourceTrackingPref','ScratchOrgManagementPref','ShapeExportPref',
                               'PRMAccRelPref'];

const settingValuesBugsRelated = ['enableOmniAutoLoginPrompt','enableOmniSecondaryRoutingPriority',
                                  'VoiceCallListEnabled','VoiceCallRecordingEnabled','VoiceCoachingEnabled','VoiceConferencingEnabled',
                                  'VoiceEnabled','VoiceLocalPresenceEnabled','VoiceMailDropEnabled','VoiceMailEnabled','CallDispositionEnabled'];
                              
const settingValuesBugsToInvestigate = ['enableEngagementHistoryDashboards','EventLogWaveIntegEnabled','SendThroughGmailPref',
                                        'PardotAppV1Enabled','PardotEmbeddedAnalyticsPref','PardotEnabled',
                                        'allowUsersToRelateMultipleContactsToTasksAndEvents','socialCustomerServiceSettings',
                                        'opportunityFilterSettings','enableAccountOwnerReport','defaultCaseOwner','PortalUserShareOnCase',
                                        'keepRecordTypeOnAssignmentRule','webToCase','routingAddresses'];

// TODO: manage dependencies correctly: for instance, setting "enableCommunityWorkspaces" requires "features":["Communities"]
const featureDependencies = new Map<string, String>([['enableCommunityWorkspaces','Communities']]);

export default class Extract extends SfdxCommand {

  public static description = messages.getMessage('commandDescription');

  public static examples = [
    `$ sfdx texei:org:shape:extract -u bulma@capsulecorp.com`
  ];

  protected static flagsConfig = {
    outputdir: flags.string({ char: 'd', description: messages.getMessage('directoryFlagDescription'), default: 'config' }),
    scope: flags.string({ char: 's', description: messages.getMessage('scopeFlagDescription'), options: ['basic', 'full', 'shaperepresentation'], default: 'basic' })
  };

  // Comment this out if your command does not require an org username
  protected static requiresUsername = true;

  // Comment this out if your command does not support a hub org username
  protected static requiresDevhubUsername = false;

  // Set this to true if your command requires a project workspace; 'requiresProject' is false by default
  protected static requiresProject = false;

  public async run(): Promise<any> {
    
    this.ux.warn('This command is in beta, only extracting some settings. Read more at https://github.com/texei/texei-sfdx-plugin/blob/master/org-shape-command.md');
    this.ux.startSpinner('Extracting Org Shape', null, { stdout: true });

    // Query org for org infos
    const query = 'Select Name, Country, LanguageLocaleKey, OrganizationType from Organization';
    const conn = this.org.getConnection();
    const orgInfos = await conn.query(query) as any;

    let featureList: any = [];
    let definitionValues: any = {};
    let definitionValuesTemp: any = {};
    definitionValuesTemp.settings = {};

    const settingValuesToIgnore = (this.flags.scope === 'full') ?
                                  [] :
                                  settingValuesProdOnly.concat(settingValuesBugsRelated).concat(settingValuesBugsToInvestigate);

    // Getting API Version
    // TODO: put this in a helper ? Is there a Core library method to get this OOTB ?
    let apiVersion = this.flags.apiversion;

    // if there is an api version set via the apiversion flag, use it
    // Otherwise use the latest api version available on the org
    if (!apiVersion) {
      apiVersion = await this.org.retrieveMaxApiVersion();
    }

    if (this.flags.scope === 'shaperepresentation') {
      const shapeQuery = `Select Edition, Features, Settings from ShapeRepresentation where Status = 'Active'`;
      try {
        const shapeRepresentation = (await conn.query(shapeQuery) as any).records[0];
        
        // Construct the object with all values
        definitionValues.orgName = orgInfos.records[0].Name;
        if (shapeRepresentation.Edition) {
          definitionValues.edition = await toTitleCase(shapeRepresentation.Edition);
        }
        definitionValues.language = orgInfos.records[0].LanguageLocaleKey;
        if (shapeRepresentation.Features) {
          // Today this doesn't work because:
          // - Some values can't be set manually, ex: 250 Custom Apps whereas max allowed in scratch def file is 30
          // - Case isn't correct (even though this doesn't seem to prevent creation)
          definitionValues.features = shapeRepresentation.Features.split(';');
        }
        if (shapeRepresentation.Settings) {
          // Still some bugs/issues:
          // - "OrdersEnabled must be specified in the metadata" (enableOrders)
          // - Some Prod/DevHub specific values to remove: "enableScratchOrgManagementPref"

          // Removing unwanted settings
          let shapeSettings = JSON.parse(shapeRepresentation.Settings);
          delete shapeSettings.devHubSettings;
          definitionValues.settings = shapeSettings;
        }
      }
      catch(ex) {
        throw new SfdxError('Unable to query ShapeRepresentation, make sure to target an org with Org Shape enabled and a shape created.');
      }
    }
    else {
      // Querying Settings
      const settingPromises = [];
      var types = [{type: 'Settings', folder: null}];
      await conn.metadata.list(types, apiVersion, function(err, metadata) {
        if (err) { return console.error('err', err); }

          for (let meta of metadata) {
            const settingType = meta.fullName+meta.type;

            // Querying settings details - Is there a way to do only 1 query with jsforce ?
            const settingPromise = conn.metadata.read(settingType, settingType);
            settingPromises.push(settingPromise);
          }
      });

      // Waiting for all promises to resolve
      await Promise.all(settingPromises).then((settingValues) => {
        // TODO: Write these in the file. - Is everything part of the scratch definition file ? For instance Business Hours ?
        // Upper camel case --> lower camel case ; ex: OmniChannelSettings --> omniChannelSettings

        for (const setting of settingValues) {
          // TODO: manage dependencies on features

          // For whatever reason, this setting has not the same format as others
          if (setting.fullName == 'OrgPreferenceSettings') {

            const settingsName = this.toLowerCamelCase(setting.fullName);
            let settingValues: any = {};
            for (const subsetting of setting.preferences) {

              if (!settingValuesToIgnore.includes(subsetting.settingName)) {
                const settingName = this.toLowerCamelCase(subsetting.settingName);
                settingValues[settingName] = subsetting.settingValue;

                // Checking if there is a feature dependency
                if (featureDependencies.has(settingName)) {
                  featureList.push(featureDependencies.get(settingName));
                }
              }
            }

            definitionValuesTemp.settings[settingsName] = settingValues;
          }

          // FIXME: Lots of settings have errors (for instance linked to metadata)
          // TODO: Add to org-shape-command.md
          // ForecastingSettings
          // Error  shape/settings/Forecasting.settings  Forecasting  Cannot resolve Forecasting Type from name or attributes

          // searchSettings (Includes custom objects not there yet)
          // Error  shape/settings/Search.settings  Search  Entity is null or entity element's name is null

          // Territory2Settings
          // Error  shape/settings/Territory2.settings   Territory2   Not available for deploy for this organization

          // Error  shape/settings/Account.settings        Account        You cannot set a value for enableAccountOwnerReport unless your organization-wide sharing access level for Accounts is set to Private.
          
          // Error  shape/settings/Case.settings           Case           CaseSettings: There are no record types defined for Case.
          // Error  shape/settings/Case.settings  Case  CaseSettings: Specify the default case user.
          // Error  shape/settings/Case.settings  Case  In field: caseOwner - no Queue named myQueue found
          // Error  shape/settings/Case.settings  Case  WebToCaseSettings: Invalid caseOrigin Formulaire
          
          // Error  shape/settings/OrgPreference.settings  OrgPreference  You do not have sufficient rights to access the organization setting: PortalUserShareOnCase
          
          // TODO: Test all settings and add them to org-shape-command.md if it doesn't work
          const settingsToTest = ['AccountSettings',
                                  'ActivitiesSettings',
                                  'AddressSettings',
                                  'BusinessHoursSettings',
                                  'CaseSettings',
                                  'CommunitiesSettings',
                                  'CompanySettings',
                                  'ContractSettings',
                                  'EntitlementSettings',
                                  'FileUploadAndDownloadSecuritySettings',
                                  'IdeasSettings',
                                  'MacroSettings',
                                  'MobileSettings',
                                  'NameSettings',
                                  'OmniChannelSettings',
                                  'OpportunitySettings',
                                  'OrderSettings',
                                  'PathAssistantSettings',
                                  'ProductSettings',
                                  'QuoteSettings',
                                  'SecuritySettings',
                                  'SocialCustomerServiceSettings'];

          if (setting.fullName !== undefined && (settingsToTest.includes(setting.fullName) || this.flags.scope === 'full')) {

            const settingName = this.toLowerCamelCase(setting.fullName);
            if (!settingValuesToIgnore.includes(settingName)) {
              const formattedSetting = this.formatSetting(setting);

              // All this code to ignore values should be refactored in a better way, todo
              for (const property in setting) {
                
                // Checking if there is a feature dependency
                if (featureDependencies.has(property)) {
                  featureList.push(featureDependencies.get(property));
                }

                if (setting.hasOwnProperty(property) && settingValuesToIgnore.includes(property)) {
                  delete setting[property];
                }
                
                // TODO: Handle recursivity correctly
                for (const prop in setting[property]) {
                  if (setting.hasOwnProperty(property) && setting[property].hasOwnProperty(prop) && settingValuesToIgnore.includes(prop)) {
                    delete setting[property][prop];
                  }
                }
              }

              definitionValuesTemp.settings[settingName] = formattedSetting;
            }
          }
        }

        // Construct the object with all values
        definitionValues.orgName = orgInfos.records[0].Name;
        definitionValues.edition = this.mapOrganizationTypeToScratchOrgEdition(orgInfos.records[0].OrganizationType);
        definitionValues.language = orgInfos.records[0].LanguageLocaleKey;

        // Adding features if needed
        if (featureList.length > 0) {
          definitionValues.features = featureList;
        }
        definitionValues.settings = definitionValuesTemp.settings;
      });
    }

    // If a path was specified, add it
    let filePath = definitionFileName;
    if (this.flags.outputdir) {
      filePath = path.join(
        this.flags.outputdir,
        definitionFileName
      );
    }
    
    // Write project-scratch-def.json file
    const saveToPath = path.join(
      process.cwd(),
      filePath
    );

    await fs.writeFile(saveToPath, this.removeQuotes(JSON.stringify(definitionValues, null, 2)), 'utf8', function (err) {
      if (err) {
        throw new SfdxError(`Unable to write definition file at path ${process.cwd()}: ${err}`);
      }
    });
    
    this.ux.stopSpinner('Done.');

    // Everything went fine, return an object that will be used for --json
    return { org: this.org.getOrgId(), message: definitionValues };
  }

  private toLowerCamelCase(label) {
    return label.charAt(0).toLowerCase() + label.slice(1);
  }

  // Is there a better way to do this ?
  private removeQuotes(myJson) {
    myJson = myJson.replace(new RegExp('"true"', 'g'), true);
    myJson = myJson.replace(new RegExp('"false"', 'g'), false);
    return myJson;
  }

  private formatSetting(myJson) {

    this.toLowerCamelCase(myJson.fullName);
    delete myJson.fullName;

    return myJson;
  }

  /**
   * This maps organization types to one of the 4 available scratch org editions with the fallback of "Developer".
   * Sources:
   *  [Way to identify Salesforce edition using API?](https://salesforce.stackexchange.com/questions/216/way-to-identify-salesforce-edition-using-api)
   *  [Salesforce Editions That Are No Longer Sold](https://help.salesforce.com/articleView?id=overview_other_editions.htm&type=5)
   *  [Scratch Org Definition Configuration Values](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_scratch_orgs_def_file_config_values.htm)
   * @param organizationType
   */
  private mapOrganizationTypeToScratchOrgEdition(organizationType) {
    // possible organization types as of v47.0:
    // ["Team Edition","Professional Edition","Enterprise Edition","Developer Edition","Personal Edition","Unlimited Edition","Contact Manager Edition","Base Edition"]
    // Base Edition: https://twitter.com/EvilN8/status/430810563044601856
    if (["Team Edition", "Personal Edition", "Base Edition"].includes(organizationType)) {
      return "Group";
    }
    if (["Contact Manager Edition"].includes(organizationType)) {
      return "Professional";
    }
    if (["Unlimited Edition"].includes(organizationType)) {
      return "Enterprise";
    }
    const sanitizedOrganizationType = organizationType.replace(" Edition", "");
    if (
      ["Group", "Professional", "Enterprise", "Developer"].includes(sanitizedOrganizationType)
    ) {
      return sanitizedOrganizationType;
    }
    return "Developer";
  }
}