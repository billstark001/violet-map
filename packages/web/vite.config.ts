import react from '@vitejs/plugin-react';
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
  { name: 'vendor-three', test: (id) => includesPackage(id, 'three'), priority: 40 },
  { name: 'vendor-radix', test: (id) => normalizedModuleId(id).includes('/node_modules/@radix-ui/'), priority: 30 },
  {
    name: 'vendor-react',
    test: (id) => ['react', 'react-dom', 'i18next', 'react-i18next'].some((pkg) => includesPackage(id, pkg)),
    priority: 20,
  },
  { name: 'vendor-storage', test: (id) => includesPackage(id, 'idb'), priority: 10 },
  { name: 'vendor', test: isNodeModule, priority: 0 },
];

function isKnownThirdPartyWarning(message: string): boolean {
  return (
    message.includes('has been externalized for browser compatibility')
    && (
      message.includes('prismarine-nbt')
      || message.includes('protodef-validator')
    )
  ) || (
    message.includes('Use of direct `eval`')
    && message.includes('protodef')
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
  plugins: [react()],
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
    port: 5173,
    proxy: { '/api': process.env.API_PROXY ?? 'http://localhost:8787' },
  },
});
