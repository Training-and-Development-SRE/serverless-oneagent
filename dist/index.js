"use strict";
// ----------------------------------------------------------------------------
// The MIT License
//
// Copyright (c) 2016-2018 Dynatrace Corporation
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
// ----------------------------------------------------------------------------
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const Npm = require("npm");
const ChildProcess = require("child_process");
const Stream = require("stream");
const Path = require("path");
const Util = require("util");
const FileSystem = require("fs");
const _ = require("lodash");
// ============================================================================
/**
 * helper class to suppress npm outputs to console
 * npm outputs clutter partially later log messages.
 */
class LogStream extends Stream.Duplex {
    constructor() {
        super();
    }
    _write() {
        // intentionally left blank
    }
    _read() {
        // intentionally left blank
    }
}
// ============================================================================
/**
 * depending on other installed plugins, this plugin will inject the agent
 * differently to the serverless deployment
 */
var DeploymentMode;
(function (DeploymentMode) {
    /**
     * it is yet undetermined which mode we shall be running
     */
    DeploymentMode[DeploymentMode["Undetermined"] = 0] = "Undetermined";
    /**
     * serverless without other (known) plugins that alter serverless packaging
     * behavior
     */
    DeploymentMode[DeploymentMode["PlainServerless"] = 1] = "PlainServerless";
    /**
     * Webpack operation mode. Webpack preprocess .js files and create the zip
     * package for serverless.
     */
    DeploymentMode[DeploymentMode["Webpack"] = 2] = "Webpack";
    /**
     * scopes of hooks can be bound to DeploymentMode. This tells that the the
     * hook shall be installed disregarding the mode.
     */
    DeploymentMode[DeploymentMode["All"] = 3] = "All";
})(DeploymentMode || (DeploymentMode = {}));
// ============================================================================
/**
 * implements a serverless plugin to inject Dynatrace OneAgent into a serverless
 * deployment (packaging)
 */
class DynatraceOneAgentPlugin {
    /**
     * plugin ctor
     * register for events and determine deployment mode
     * @param serverless
     * @param options
     */
    constructor(serverless, options) {
        this.serverless = serverless;
        this.options = options;
        this.commands = {};
        this.hooks = {};
        this.deploymentMode = DeploymentMode.Undetermined;
        this.defaultConfig = {};
        this.cannotTailorErrMsg = "could not determine serverless-webpack intermediate files to tailor OneAgent" +
            "npm module(things will work, but zip package will contain files not need for selected Node.js runtime version";
        /*
         * restrict this plugin to supported providers
         */
        this.provider = this.serverless.getProvider("aws");
        this.determineDeploymentMode();
        this.env = {
            agentOptions: options["dt-lambda-options"],
            debug: options["dt-debug"] !== undefined
        };
        if (this.deploymentMode === DeploymentMode.Webpack) {
            this.preProcessServerlessWebPackDeployment();
        }
        this.defineEventHook("before:package:createDeploymentArtifacts", this.preProcessPlainServerlessDeployment, DeploymentMode.PlainServerless);
        this.defineEventHook("after:package:createDeploymentArtifacts", this.postProcessPlainServerlessDeployment, DeploymentMode.PlainServerless);
        this.defineEventHook("before:aws:common:validate", this.preProcessServerlessWebPackDeployment, DeploymentMode.Webpack);
        this.defineEventHook("after:webpack:package:packExternalModules", this.postProcessServerlessWebPackDeployment, DeploymentMode.Webpack);
    }
    /**
     * @returns true if --verbose or -v options are set
     */
    get isVerbose() {
        return this.options.v || this.options.verbose || false;
    }
    /**
     * @returns this plugin specific configuration
     */
    get config() {
        if (!this.serverless.service || !this.serverless.service.custom || !this.serverless.service.custom["serverless-oneagent"]) {
            return this.defaultConfig;
        }
        return this.serverless.service.custom["serverless-oneagent"] || this.defaultConfig;
    }
    /**
     * @returns the requested Dynatrace OneAgent npm module version to be passed to npm (e.g. next)
     */
    get npmModuleVersion() {
        return this.config.npmModuleVersion;
    }
    /**
     * get module name with optional version tag to be passed to npm install command
     */
    get qualifiedNpmModuleName() {
        return `@dynatrace/oneagent${!this.npmModuleVersion ? "" : "@" + this.npmModuleVersion}`;
    }
    /**
     * feed log messages to serverless logging facility
     * @param msg
     */
    log(msg) {
        const lines = ("" + msg).split(/\n|\r\n/);
        lines.forEach((l) => {
            if (l.length > 0) {
                this.serverless.cli.log("[Dynatrace OneAgent] " + l);
            }
        });
    }
    /**
     * conditional logging - log if --verbose / -v option is set
     * @param msg
     */
    logVerbose(msg) {
        if (this.isVerbose) {
            this.log(msg);
        }
    }
    /**
     * determine deployment mode from configured plugins
     * determines deployment mode dependent on configured plugins
     */
    determineDeploymentMode() {
        if (this.serverless.service.plugins.some((p) => p === "serverless-webpack")) {
            this.deploymentMode = DeploymentMode.Webpack;
        }
        else {
            this.deploymentMode = DeploymentMode.PlainServerless;
        }
        this.logVerbose(`switching to '${DeploymentMode[this.deploymentMode]}' mode`);
    }
    /**
     * utility function to define event hooks
     * @param event event name to subscribe for
     * @param hook method to call upon event
     * @param appliesTo restrict hook execution to specific deployment mode
     */
    defineEventHook(event, hook, appliesTo = DeploymentMode.All) {
        this.logVerbose(`installing listener for '${event}' in context of ${DeploymentMode[appliesTo]}`);
        this.hooks[event] = () => {
            if (this.deploymentMode === DeploymentMode.Undetermined) {
                this.determineDeploymentMode();
            }
            if (this.deploymentMode === appliesTo || appliesTo === DeploymentMode.All) {
                this.logVerbose(`executing event '${event}'`);
                return hook.apply(this);
            }
        };
    }
    /**
     * preprocess a serverless-webpack deployment
     * extend serverless-webpack configuration to force include the OneAgent npm module
     * yaml:
     * custom:
     * 	webpack:
     * 	  includeModules:
     *      forceInclude:
     *        - "@dynatrace/oneagent"
     */
    preProcessServerlessWebPackDeployment() {
        return __awaiter(this, void 0, void 0, function* () {
            if (_.has(this.serverless, "service.custom.webpack.includeModules.forceInclude")) {
                this.serverless.service.custom.webpack.includeModules.forceInclude.push(this.qualifiedNpmModuleName);
            }
            else {
                _.set(this.serverless, "service.custom.webpack.includeModules.forceInclude", [this.qualifiedNpmModuleName]);
            }
            yield this.setDtLambdaOptions();
        });
    }
    /**
     * post process a serverless-webpack deployment
     * serverless-webpack will install the OneAgent npm module. before webpack bundles the files to
     * a zip package, apply following post processing:
     * - tailor the npm module to the selected Node.js runtime version
     * - rewrite Lambda function handler definition
     */
    postProcessServerlessWebPackDeployment() {
        return __awaiter(this, void 0, void 0, function* () {
            let tailoringSucceeded = Array.isArray(this.serverless.pluginManager.plugins);
            if (tailoringSucceeded) {
                try {
                    // get ServerlessWebpack class
                    const ctor = require("serverless-webpack");
                    let slsw;
                    // search for the slsw plugin instance
                    this.serverless.pluginManager.plugins.some((p) => {
                        // p.compileStats.stats[0].compilation.compiler.outputPath
                        if (p instanceof ctor) {
                            slsw = p;
                        }
                        return slsw !== undefined;
                    });
                    if (slsw !== undefined) {
                        /*
                         * iterate all compilation results and invoke tailoring in the output folders
                         */
                        tailoringSucceeded = _.has(slsw, "compileStats.stats") && Util.isArray(slsw.compileStats.stats);
                        if (tailoringSucceeded) {
                            const promises = slsw.compileStats.stats.map((cs) => __awaiter(this, void 0, void 0, function* () {
                                if (_.has(cs, "compilation.compiler.outputPath")) {
                                    yield this.tailorOneAgentModule(cs.compilation.compiler.outputPath);
                                }
                                else {
                                    tailoringSucceeded = false;
                                }
                            }));
                            // wait for all tailoring scripts to finish
                            yield Promise.all(promises);
                        }
                    }
                }
                catch (e) {
                    tailoringSucceeded = false;
                }
            }
            if (!tailoringSucceeded) {
                this.log(this.cannotTailorErrMsg);
            }
            yield this.rewriteHandlerDefinitions();
        });
    }
    /**
     * plain serverless deployment preprocessing
     * - install Dynatrace OneAgent npm module
     * - tailor the module
     * - set options
     */
    preProcessPlainServerlessDeployment() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.npmInstallOneAgentModule();
            yield this.tailorOneAgentModule();
            yield this.setDtLambdaOptions();
        });
    }
    /**
     * plain serverless deployment post processing
     * - rewrite handler definitions (this could be done in preprocessing, too)
     * - uninstall npm module installed in preprocessing
     */
    postProcessPlainServerlessDeployment() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.rewriteHandlerDefinitions();
            yield this.npmUninstallOneAgentModule();
        });
    }
    /**
     * change all function handler definitions to load the agent first
     * e.g. rewrite
     *    handler: index.hello
     * to
     *    handler: node_modules/@dynatrace/oneagent.index$hello
     */
    rewriteHandlerDefinitions() {
        /*
         * rewrite handler function specifications. do this in the aftermath of deployment artifacts
         * creation. Rewriting the handler function before would trigger webpack attempt to bundle
         * the OneAgent files.
         */
        Object.keys(this.serverless.service.functions).forEach((k) => {
            const fn = this.serverless.service.functions[k];
            const origHandler = fn.handler;
            const splitted = origHandler.split(".");
            fn.handler = `node_modules/@dynatrace/oneagent/index.${splitted[0]}$${splitted[1]}`;
            this.log(`modifying Lambda handler ${k}: ${origHandler} -> ${fn.handler}`);
        });
    }
    /**
     * The OneAgent npm module includes native extensions for all supported Node.js versions
     * Lambda function is specified for a specific Node.js version, thus clear the unneeded
     * binaries from the module to reduce zip package size
     */
    tailorOneAgentModule(nodeModulesPath = "./") {
        this.log(`tailoring OneAgent module in ${nodeModulesPath}`);
        return new Promise((resolve, reject) => {
            // determine selected runtime and version
            if (!_.has(this.serverless, "service.provider.runtime")) {
                this.log(this.cannotTailorErrMsg);
                reject();
                return;
            }
            const runtime = this.serverless.service.provider.runtime;
            const tailorArgs = [];
            const result = /nodejs([0-9]+).[0-9.]+/.exec(runtime);
            if (result !== null) {
                tailorArgs.push(`--AwsLambdaV${result[1]}`);
            }
            else {
                reject(`unsupported Lambda runtime '${runtime}'`);
                return;
            }
            try {
                // start tailoring script
                const cmd = Path.join(nodeModulesPath, "node_modules/.bin/dt-oneagent-tailor");
                FileSystem.accessSync(cmd);
                this.logVerbose(`executing ${cmd} ${tailorArgs.join(" ")}`);
                const child = ChildProcess.spawn(cmd, tailorArgs, { windowsHide: true });
                child.stdout.on("data", (data) => this.logVerbose(data));
                child.stderr.on("data", (data) => this.logVerbose(data));
                child.on("close", (rc, signal) => {
                    if (rc === 0) {
                        this.logVerbose("tailoring OneAgent module succeeded");
                        resolve();
                    }
                    else {
                        reject(signal);
                    }
                });
            }
            catch (e) {
                this.log(`tailoring OneAgent module failed: ${e}`);
                reject(e);
            }
        });
    }
    /**
     * run npm install programmatically to install OneAgent npm module
     */
    npmInstallOneAgentModule() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.setupNpm();
            return new Promise((resolve, reject) => {
                this.log(`Installing Dynatrace oneagent npm module`);
                const args = [this.qualifiedNpmModuleName];
                Npm.commands.install(args, (err) => {
                    if (!err) {
                        this.logVerbose(`npm install succeeded`);
                        resolve();
                    }
                    else {
                        this.log(`npm install failed: ${err}`);
                        reject(err);
                    }
                });
            });
        });
    }
    /**
     * run npm uninstall programmatically to remove previously installed OneAgent npm module
     */
    npmUninstallOneAgentModule() {
        return new Promise((resolve, reject) => {
            this.log(`Uninstalling Dynatrace oneagent npm module`);
            const args = [this.qualifiedNpmModuleName];
            Npm.commands.uninstall(args, (err) => {
                if (!err) {
                    this.logVerbose(`npm uninstall succeeded`);
                    resolve();
                }
                else {
                    this.log(`npm uninstall failed: ${err}`);
                    reject(err);
                }
            });
        });
    }
    /**
     * setup npm for module installation
     */
    setupNpm() {
        return new Promise((resolve, reject) => {
            // silence npm if not in verbose mode
            const options = {
                logstream: this.isVerbose ? process.stderr : new LogStream()
            };
            Npm.load(options, (err) => {
                // Npm.on("log", this.logVerbose.bind(this));
                if (!err) {
                    this.logVerbose(`npm setup`);
                    resolve();
                }
                else {
                    this.log(`npm load failed: ${err}`);
                    reject(err);
                }
            });
        });
    }
    /**
     * set OneAgent options in environment
     * OneAgent options can be passed by command line with --dt-lambda-options='...'
     */
    setDtLambdaOptions() {
        if (this.env.agentOptions !== undefined) {
            this.logVerbose(`adding environment variable DT_LAMBDA_OPTIONS='${this.env.agentOptions}'`);
            _.set(this.serverless, "service.provider.environment.DT_LAMBDA_OPTIONS", this.env.agentOptions);
        }
        if (this.env.debug !== undefined) {
            this.logVerbose(`adding environment variable DEBUG=dynatrace`);
            _.set(this.serverless, "service.provider.environment.DEBUG", "dynatrace");
        }
    }
}
module.exports = DynatraceOneAgentPlugin;
//# sourceMappingURL=index.js.map