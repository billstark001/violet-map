import preact from '@preact/preset-vite';
import { createLogger, defineConfig, type Rolldown } from 'vite';

type CodeSplittingGroup = NonNullable<
  Exclude<NonNullable<Rolldown.OutputOptions['codeSplitting']>, boolean>['groups']
>[number];

function normalizedModuleId(id: string): string {
  return id.replaceAll('\\', '/');
}

function isNodeModule(id: string): boolean {
  return normalizedModuleId(id).includes('/node_modules/');
}

function includesPackage(id: string, packageName: string): boolean {
  return normalizedModuleId(id).includes(`/node_modules/${packageName}/`);
}

const vendorGroups: CodeSplittingGroup[] = [
  {
    name: 'overlay-gltf',
    includeDependenciesRecursively: false,
    test: (id) =>
      includesPackage(id, 'three') &&
      /\/examples\/jsm\/(loaders\/GLTFLoader|utils\/(?:BufferGeometryUtils|SkeletonUtils))\.js$/.test(
        normalizedModuleId(id),
      ),
    priority: 50,
  },
  { name: 'vendor-three', test: (id) => includesPackage(id, 'three'), priority: 40 },
  {
    name: 'vendor-ui',
    test: (id) =>
      ['preact', 'i18next'].some((pkg) => includesPackage(id, pkg)) ||
      normalizedModuleId(id).includes('/node_modules/@preact/'),
    priority: 20,
  },
  { name: 'vendor-storage', test: (id) => includesPackage(id, 'idb'), priority: 10 },
  { name: 'vendor', test: isNodeModule, priority: 0 },
];

function isKnownThirdPartyWarning(message: string): boolean {
  return (
    (message.includes('has been externalized for browser compatibility') &&
      (message.includes('prismarine-nbt') || message.includes('protodef-validator'))) ||
    (message.includes('Use of direct `eval`') && message.includes('protodef'))
  );
}

const logger = createLogger();
const warn = logger.warn.bind(logger);
const warnOnce = logger.warnOnce.bind(logger);

logger.warn = (message, options) => {
  if (isKnownThirdPartyWarning(message)) return;
  warn(message, options);
};

logger.warnOnce = (message, options) => {
  if (isKnownThirdPartyWarning(message)) return;
  warnOnce(message, options);
};

export default defineConfig({
  plugins: [preact({ reactAliasesEnabled: false })],
  base: process.env.VITE_BASE_PATH ?? '/',
  customLogger: logger,
  build: {
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      onLog(level, log, defaultHandler) {
        if (level === 'warn' && isKnownThirdPartyWarning(log.message)) return;
        defaultHandler(level, log);
      },
      output: {
        codeSplitting: { groups: vendorGroups },
      },
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: { exclude: ['@violet-map/core'] },
  server: {
    port: 3305,
    proxy: { '/api': process.env.API_PROXY ?? 'http://localhost:3300' },
  },
});
