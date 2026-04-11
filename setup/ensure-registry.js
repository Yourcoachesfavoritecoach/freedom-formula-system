/**
 * Ensure Registry
 * Creates client-registry.json from template if it doesn't exist.
 * Called on startup to handle fresh deploys.
 */

const fs = require('fs');
const path = require('path');

const registryPath = path.resolve(__dirname, 'client-registry.json');
const templatePath = path.resolve(__dirname, 'client-registry.template.json');

function ensureRegistry() {
  if (fs.existsSync(registryPath)) return;

  console.log('[SETUP] client-registry.json not found. Creating from template...');

  // Check for CLIENT_REGISTRY env var (JSON string) first
  if (process.env.CLIENT_REGISTRY) {
    try {
      const registry = JSON.parse(process.env.CLIENT_REGISTRY);
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
      console.log('[SETUP] Created client-registry.json from CLIENT_REGISTRY env var');
      return;
    } catch (e) {
      console.error('[SETUP] CLIENT_REGISTRY env var is not valid JSON:', e.message);
    }
  }

  // Fall back to template
  if (fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, registryPath);
    console.log('[SETUP] Created client-registry.json from template. Add clients via admin endpoint.');
  } else {
    // Create minimal empty registry
    fs.writeFileSync(registryPath, JSON.stringify({ clients: [] }, null, 2) + '\n');
    console.log('[SETUP] Created empty client-registry.json');
  }
}

module.exports = { ensureRegistry };

// Auto-run on require
ensureRegistry();
