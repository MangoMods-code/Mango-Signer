// Tiny JSON database saved on disk (atomic writes).
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file) {
    this.file = file;
    this.data = { apps: [], certs: [], signed: [], users: [], invites: [], categories: [], collections: [], requests: [], installLog: [], sources: [], tweaks: [], presets: [], settings: {} };
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...loaded };
    } catch { /* first run */ }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get apps() { return this.data.apps; }
  get certs() { return this.data.certs; }
  get signed() { return this.data.signed; }
  get settings() { return this.data.settings; }
  get users() { return this.data.users; }
  get invites() { return this.data.invites; }
  get categories() { return this.data.categories; }
  get collections() { return this.data.collections; }
  get requests() { return this.data.requests; }
  get installLog() { return this.data.installLog; }
  get sources() { return this.data.sources; }
  get tweaks() { return this.data.tweaks; }
  get presets() { return this.data.presets; }
}

module.exports = Store;
