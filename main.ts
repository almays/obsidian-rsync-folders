import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TextAreaComponent
} from "obsidian";
import { spawn } from "child_process";
import * as path from "path";

type SyncDirection = "push" | "pull" | "two-way";
type MappingPathType = "folder" | "exact";

interface FolderMapping {
  id: string;
  name: string;
  localPath: string;
  remotePath: string;
  pathType: MappingPathType;
  direction: SyncDirection;
  enabled: boolean;
}

interface RsyncFoldersSettings {
  rsyncPath: string;
  serverHost: string;
  serverUser: string;
  sshPort: string;
  sshKeyPath: string;
  remoteBasePath: string;
  extraArgs: string;
  deleteExtraneous: boolean;
  dryRun: boolean;
  mappings: FolderMapping[];
}

const DEFAULT_SETTINGS: RsyncFoldersSettings = {
  rsyncPath: "rsync",
  serverHost: "",
  serverUser: "",
  sshPort: "22",
  sshKeyPath: "",
  remoteBasePath: "",
  extraArgs: "-az --human-readable --progress",
  deleteExtraneous: false,
  dryRun: false,
  mappings: []
};

interface RsyncResult {
  command: string;
  exitCode: number | null;
  output: string;
}

export default class RsyncFoldersPlugin extends Plugin {
  settings: RsyncFoldersSettings;
  private statusEl: HTMLElement | null = null;
  private lastOutput = "";
  private isRunning = false;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new RsyncFoldersSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.setStatus("Rsync idle");

    this.addRibbonIcon("refresh-cw", "Rsync folders", async () => {
      await this.syncAll("configured");
    });

    this.addCommand({
      id: "sync-all-mappings",
      name: "Sync all mappings",
      callback: async () => this.syncAll("configured")
    });

    this.addCommand({
      id: "push-all-mappings",
      name: "Push all mappings",
      callback: async () => this.syncAll("push")
    });

    this.addCommand({
      id: "pull-all-mappings",
      name: "Pull all mappings",
      callback: async () => this.syncAll("pull")
    });

    this.addCommand({
      id: "show-last-rsync-output",
      name: "Show last rsync output",
      callback: () => new RsyncLogModal(this.app, this.lastOutput || "No rsync output yet.").open()
    });
  }

  onunload() {
    this.statusEl = null;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.mappings = this.settings.mappings ?? [];
    this.settings.mappings.forEach((mapping) => {
      mapping.pathType = mapping.pathType ?? "folder";
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async syncAll(mode: SyncDirection | "configured") {
    if (this.isRunning) {
      new Notice("Rsync is already running.");
      return;
    }

    const validation = this.validateGlobalSettings();
    if (validation) {
      new Notice(validation);
      return;
    }

    const mappings = this.settings.mappings.filter((mapping) => mapping.enabled);
    if (mappings.length === 0) {
      new Notice("No enabled folder mappings.");
      return;
    }

    this.isRunning = true;
    this.lastOutput = "";
    this.setStatus("Rsync running");
    new Notice(`Rsync started for ${mappings.length} mapping(s).`);

    try {
      for (const mapping of mappings) {
        await this.syncMapping(mapping, mode);
      }

      this.setStatus("Rsync complete");
      new Notice("Rsync complete.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendOutput(`\nERROR: ${message}\n`);
      this.setStatus("Rsync failed");
      new Notice(`Rsync failed: ${message}`);
      new RsyncLogModal(this.app, this.lastOutput).open();
    } finally {
      this.isRunning = false;
    }
  }

  private async syncMapping(mapping: FolderMapping, mode: SyncDirection | "configured") {
    const direction = mode === "configured" ? mapping.direction : mode;

    this.validateMapping(mapping);

    if (direction === "two-way") {
      await this.runRsync(mapping, "pull");
      await this.runRsync(mapping, "push");
      return;
    }

    await this.runRsync(mapping, direction);
  }

  private async runRsync(mapping: FolderMapping, direction: Exclude<SyncDirection, "two-way">) {
    const args = this.buildRsyncArgs(mapping, direction);
    const commandText = `${this.settings.rsyncPath} ${args.map(shellQuote).join(" ")}`;

    this.appendOutput(`\n$ ${commandText}\n`);
    this.setStatus(`Rsync ${direction}: ${mapping.name || mapping.localPath}`);

    const result = await spawnRsync(this.settings.rsyncPath, args);
    this.appendOutput(result.output);

    if (result.exitCode !== 0) {
      throw new Error(`rsync exited with code ${result.exitCode}`);
    }
  }

  private buildRsyncArgs(mapping: FolderMapping, direction: Exclude<SyncDirection, "two-way">): string[] {
    const args = splitArgs(this.settings.extraArgs);

    if (this.settings.deleteExtraneous) {
      args.push("--delete");
    }

    if (this.settings.dryRun) {
      args.push("--dry-run");
    }

    const sshArgs = this.buildSshArgs();
    if (sshArgs.length > 0) {
      args.push("-e", ["ssh", ...sshArgs].map(shellQuote).join(" "));
    }

    const localPath = formatMappingPath(
      path.join(this.getVaultBasePath(), normalizeLocalPath(mapping.localPath)),
      mapping.pathType
    );
    const remotePath = formatMappingPath(this.formatRemotePath(mapping.remotePath), mapping.pathType);

    if (direction === "push") {
      args.push(localPath, remotePath);
    } else {
      args.push(remotePath, localPath);
    }

    return args;
  }

  private buildSshArgs(): string[] {
    const args: string[] = [];

    if (this.settings.sshPort.trim()) {
      args.push("-p", this.settings.sshPort.trim());
    }

    if (this.settings.sshKeyPath.trim()) {
      args.push("-i", this.settings.sshKeyPath.trim());
    }

    return args;
  }

  private formatRemotePath(remotePath: string): string {
    const host = this.settings.serverHost.trim();
    const user = this.settings.serverUser.trim();
    const target = user ? `${user}@${host}` : host;
    const trimmedRemotePath = remotePath.trim();
    const resolvedRemotePath = path.posix.isAbsolute(trimmedRemotePath)
      ? trimmedRemotePath
      : path.posix.join(this.settings.remoteBasePath.trim() || ".", trimmedRemotePath);

    return `${target}:${resolvedRemotePath}`;
  }

  private getVaultBasePath(): string {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const basePath = adapter.getBasePath?.();

    if (!basePath) {
      throw new Error("Unable to resolve vault base path. This plugin only supports desktop vaults.");
    }

    return basePath;
  }

  private validateGlobalSettings(): string | null {
    if (!this.settings.rsyncPath.trim()) {
      return "Set the rsync binary path first.";
    }

    if (!this.settings.serverHost.trim()) {
      return "Set the server host first.";
    }

    return null;
  }

  private validateMapping(mapping: FolderMapping) {
    if (!mapping.localPath.trim()) {
      throw new Error(`Mapping "${mapping.name || mapping.id}" has no local path.`);
    }

    if (!mapping.remotePath.trim()) {
      throw new Error(`Mapping "${mapping.name || mapping.localPath}" has no remote path.`);
    }

    if (mapping.localPath.startsWith("/") || mapping.localPath.includes("..")) {
      throw new Error(`Local path must be relative to the vault: ${mapping.localPath}`);
    }
  }

  private setStatus(text: string) {
    if (this.statusEl) {
      this.statusEl.setText(text);
    }
  }

  private appendOutput(text: string) {
    this.lastOutput += text;
  }
}

class RsyncFoldersSettingTab extends PluginSettingTab {
  plugin: RsyncFoldersPlugin;

  constructor(app: App, plugin: RsyncFoldersPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Rsync Folders" });

    new Setting(containerEl)
      .setName("Rsync binary")
      .setDesc("Path to rsync. Use plain rsync when it is available in PATH.")
      .addText((text) => text
        .setPlaceholder("rsync")
        .setValue(this.plugin.settings.rsyncPath)
        .onChange(async (value) => {
          this.plugin.settings.rsyncPath = value.trim() || "rsync";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Server host")
      .setDesc("Hostname or IP address of the server.")
      .addText((text) => text
        .setPlaceholder("example.com")
        .setValue(this.plugin.settings.serverHost)
        .onChange(async (value) => {
          this.plugin.settings.serverHost = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Server user")
      .setDesc("SSH user. Leave empty to use your local SSH default.")
      .addText((text) => text
        .setPlaceholder("deploy")
        .setValue(this.plugin.settings.serverUser)
        .onChange(async (value) => {
          this.plugin.settings.serverUser = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("SSH port")
      .setDesc("Default is 22.")
      .addText((text) => text
        .setPlaceholder("22")
        .setValue(this.plugin.settings.sshPort)
        .onChange(async (value) => {
          this.plugin.settings.sshPort = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("SSH key path")
      .setDesc("Absolute path to a private key. Leave empty to use ssh-agent or SSH config.")
      .addText((text) => text
        .setPlaceholder("/Users/you/.ssh/id_ed25519")
        .setValue(this.plugin.settings.sshKeyPath)
        .onChange(async (value) => {
          this.plugin.settings.sshKeyPath = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Remote base path")
      .setDesc("Used when a mapping remote path is relative.")
      .addText((text) => text
        .setPlaceholder("/srv/notes")
        .setValue(this.plugin.settings.remoteBasePath)
        .onChange(async (value) => {
          this.plugin.settings.remoteBasePath = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Extra rsync arguments")
      .setDesc("Shell-style arguments. Defaults to archive, compression, readable output, and progress.")
      .addTextArea((text: TextAreaComponent) => {
        text.inputEl.rows = 3;
        text
          .setPlaceholder("-az --human-readable --progress")
          .setValue(this.plugin.settings.extraArgs)
          .onChange(async (value) => {
            this.plugin.settings.extraArgs = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Delete extraneous destination files")
      .setDesc("Adds --delete. Be careful: files missing from the source can be removed from the destination.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.deleteExtraneous)
        .onChange(async (value) => {
          this.plugin.settings.deleteExtraneous = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Dry run")
      .setDesc("Adds --dry-run so rsync reports changes without writing them.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.dryRun)
        .onChange(async (value) => {
          this.plugin.settings.dryRun = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: "Folder mappings" });

    for (const mapping of this.plugin.settings.mappings) {
      this.renderMapping(containerEl, mapping);
    }

    new Setting(containerEl)
      .addButton((button) => button
        .setButtonText("Add folder mapping")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.mappings.push({
            id: cryptoRandomId(),
            name: "New mapping",
            localPath: "",
            remotePath: "",
            pathType: "folder",
            direction: "push",
            enabled: true
          });
          await this.plugin.saveSettings();
          this.display();
        }));
  }

  private renderMapping(containerEl: HTMLElement, mapping: FolderMapping) {
    const wrapper = containerEl.createDiv({ cls: "rsync-folders-mapping" });
    wrapper.createEl("h4", { text: mapping.name || "Folder mapping" });

    new Setting(wrapper)
      .setName("Enabled")
      .addToggle((toggle) => toggle
        .setValue(mapping.enabled)
        .onChange(async (value) => {
          mapping.enabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(wrapper)
      .setName("Name")
      .addText((text) => text
        .setPlaceholder("Projects")
        .setValue(mapping.name)
        .onChange(async (value) => {
          mapping.name = value;
          await this.plugin.saveSettings();
        }));

    new Setting(wrapper)
      .setName("Local vault path")
      .setDesc("Relative path inside the vault. Example: Projects/Active or Links/ClientA")
      .addText((text) => text
        .setPlaceholder("Projects/Active")
        .setValue(mapping.localPath)
        .onChange(async (value) => {
          mapping.localPath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(wrapper)
      .setName("Remote path")
      .setDesc("Absolute server path or path relative to the remote base path.")
      .addText((text) => text
        .setPlaceholder("projects/active")
        .setValue(mapping.remotePath)
        .onChange(async (value) => {
          mapping.remotePath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(wrapper)
      .setName("Path type")
      .setDesc("Folder contents adds a trailing slash. Exact path preserves a single file or symlink as that object.")
      .addDropdown((dropdown) => dropdown
        .addOption("folder", "Folder contents")
        .addOption("exact", "Exact path / symlink")
        .setValue(mapping.pathType)
        .onChange(async (value: MappingPathType) => {
          mapping.pathType = value;
          await this.plugin.saveSettings();
        }));

    new Setting(wrapper)
      .setName("Direction")
      .setDesc("Two way runs pull first, then push. It does not resolve edit conflicts.")
      .addDropdown((dropdown) => dropdown
        .addOption("push", "Push")
        .addOption("pull", "Pull")
        .addOption("two-way", "Two way")
        .setValue(mapping.direction)
        .onChange(async (value: SyncDirection) => {
          mapping.direction = value;
          await this.plugin.saveSettings();
        }));

    new Setting(wrapper)
      .addButton((button: ButtonComponent) => button
        .setButtonText("Remove")
        .setWarning()
        .onClick(async () => {
          this.plugin.settings.mappings = this.plugin.settings.mappings.filter((item) => item.id !== mapping.id);
          await this.plugin.saveSettings();
          this.display();
        }));
  }
}

class RsyncLogModal extends Modal {
  private output: string;

  constructor(app: App, output: string) {
    super(app);
    this.output = output;
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Rsync output" });
    this.contentEl.createDiv({ cls: "rsync-folders-log", text: this.output });
  }
}

function spawnRsync(command: string, args: string[]): Promise<RsyncResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true
    });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (exitCode) => {
      resolve({
        command,
        exitCode,
        output
      });
    });
  });
}

function normalizeLocalPath(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function formatMappingPath(value: string, pathType: MappingPathType): string {
  return pathType === "folder" ? ensureTrailingSlash(value) : stripTrailingSlashes(value);
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
