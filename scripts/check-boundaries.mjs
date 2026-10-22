import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const allowed = {
  core: [],
  render: ['core'],
  storage: ['core'],
  resources: ['core', 'storage'],
  server: ['core', 'storage', 'resources'],
  web: ['core', 'render'],
  admin: ['core'],
  cli: ['core', 'render', 'storage', 'server', 'resources'],
};

function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(dir, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [path.join(dir, entry.name).split(path.sep).join('/')]
          : [],
    );
}

const violations = [];

function checkViewerImport(file, name, node, fail) {
  const scope = file.slice('packages/web/src/'.length).split('/')[0];
  const local = (
    name.startsWith('.')
      ? path
          .relative(path.resolve('packages/web/src'), path.resolve(path.dirname(file), name))
          .split(path.sep)
          .join('/')
      : name.startsWith('@violet-map/web/')
        ? name.slice('@violet-map/web/'.length)
        : undefined
  )?.replace(/\.(?:[cm]?js|tsx?)$/, '');
  const destination = local?.split('/')[0];
  if (scope === 'scheduling' && local && !['scheduling', 'view'].includes(destination))
    fail('scheduler depends on execution/display implementation ' + name);
  if (scope === 'view' && local && destination !== 'view')
    fail('view contract depends on application implementation ' + name);
  if (['runtime', 'resources'].includes(scope) && destination === 'render')
    fail('execution/resource owner depends on GPU implementation ' + name);
  if (['scheduling', 'view', 'runtime'].includes(scope) && /^three(?:\/|$)/.test(name))
    fail('graphics engine dependency in ' + scope + ': ' + name);
  if (
    ['scheduling', 'view'].includes(scope) &&
    !local &&
    !/^@violet-map\/core(?:\/|$)/.test(name) &&
    !(
      scope === 'view' &&
      /^@violet-map\/render(?:\/|$)/.test(name) &&
      ts.isImportDeclaration(node) &&
      node.importClause?.isTypeOnly
    )
  )
    fail('runtime dependency in pure viewer decision/contract ' + name);
  if (
    scope === 'render' &&
    !file.endsWith('/viewerEngine.ts') &&
    ['api', 'runtime', 'resources/client', 'resources/download'].includes(local)
  )
    fail('display owner depends on HTTP transport ' + name);
}

const pureViewerGlobals = new Set([
  'window',
  'document',
  'navigator',
  'performance',
  'localStorage',
  'indexedDB',
  'globalThis',
  'fetch',
  'Worker',
  'Image',
  'OffscreenCanvas',
  'AbortController',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'queueMicrotask',
  'Date',
]);
const decisionFiles = new Set(
  files('packages/web/src').filter((file) => /^packages\/web\/src\/(?:scheduling|view)\//.test(file)),
);
const decisionProgram = ts.createProgram([...decisionFiles], {
  noResolve: true,
  noLib: true,
  target: ts.ScriptTarget.Latest,
});
const decisionChecker = decisionProgram.getTypeChecker();
const generatorDependency = /^(?:pngjs|minecraft-data|@msgpack\/msgpack)(?:\/|$)/;

for (const [owner, dependencies] of Object.entries(allowed)) {
  for (const file of files(`packages/${owner}/src`)) {
    const source = decisionFiles.has(file)
      ? decisionProgram.getSourceFile(file)
      : ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    if (!source) throw new Error('missing boundary-check source: ' + file);
    const fail = (message) => violations.push(`${file}: ${message}`);
    function inspect(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
        specifier = node.moduleReference.expression;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        specifier = node.arguments[0];
      else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require')
        specifier = node.arguments[0];
      if (specifier && !ts.isStringLiteralLike(specifier)) fail('module specifier must be statically checkable');
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const name = specifier.text;
        const target =
          name.match(/^@violet-map\/([^/]+)/)?.[1] ??
          (name.startsWith('.')
            ? path
                .resolve(path.dirname(file), name)
                .split(path.sep)
                .join('/')
                .match(/\/packages\/([^/]+)\//)?.[1]
            : undefined);
        if (target && target !== owner && !dependencies.includes(target)) fail(`forbidden dependency ${name}`);
        if (owner === 'cli' && ['render', 'storage', 'server', 'resources'].includes(target)) {
          if (
            ts.isImportDeclaration(node) &&
            !node.importClause?.isTypeOnly &&
            !(
              node.importClause?.namedBindings &&
              !node.importClause.name &&
              ts.isNamedImports(node.importClause.namedBindings) &&
              node.importClause.namedBindings.elements.length > 0 &&
              node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)
            )
          )
            fail(`static optional runtime import ${name}`);
          if (
            ts.isExportDeclaration(node) &&
            !node.isTypeOnly &&
            !(
              node.exportClause &&
              ts.isNamedExports(node.exportClause) &&
              node.exportClause.elements.length > 0 &&
              node.exportClause.elements.every((element) => element.isTypeOnly)
            )
          )
            fail(`static optional runtime export ${name}`);
          if (ts.isCallExpression(node) && !file.endsWith('/capabilities.ts'))
            fail(`optional imports must use the capability loader: ${name}`);
          if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) fail(`static optional runtime import ${name}`);
        }
        if (target && target !== owner && name.startsWith('.')) fail(`cross-package relative import ${name}`);
        if (owner === 'web') checkViewerImport(file, name, node, fail);
        if (owner === 'core' && /^(?:node:)?(?:fs|path)(?:\/|$)|^@aws-sdk\//.test(name))
          fail(`platform implementation ${name}`);
        if (owner === 'storage' && generatorDependency.test(name)) fail(`resource generator dependency ${name}`);
        if (owner === 'resources' && /^(?:node:)?sqlite$/.test(name) && !file.endsWith('/catalog/sqlite.ts'))
          fail('SQLite must remain in its explicit catalog sub-entry');
        if (owner === 'render' && /^(node:|(?:fs|path|buffer)(?:\/|$)|three(?:\/|$)|@aws-sdk\/)/.test(name))
          fail(`platform implementation ${name}`);
        if (
          ['web', 'admin'].includes(owner) &&
          /^(node:|@aws-sdk\/|pg$|drizzle-orm(?:\/|$)|@electric-sql\/)/.test(name)
        )
          fail(`server implementation ${name}`);
        if (owner === 'admin' && target === 'core' && !['@violet-map/core/contracts'].includes(name))
          fail(`heavy admin entry ${name}`);
        if (owner === 'web' && /^(?:react(?:-dom|-i18next)?(?:\/|$)|@radix-ui\/|preact\/compat(?:\/|$))/.test(name))
          fail(`React compatibility/runtime dependency in native Preact viewer: ${name}`);
      }
      if (
        ['render', 'resources'].includes(owner) &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['document', 'window', 'navigator', 'process'].includes(node.expression.text)
      )
        fail(`platform global ${node.expression.text}`);
      if (
        owner === 'render' &&
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['Worker', 'Image', 'OffscreenCanvas'].includes(node.expression.text)
      )
        fail(`browser implementation ${node.expression.text}`);
      if (owner === 'web' && /^packages\/web\/src\/(?:scheduling|view)\//.test(file)) {
        if (
          ts.isIdentifier(node) &&
          pureViewerGlobals.has(node.text) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          (node.text === 'globalThis' || !decisionChecker.getSymbolAtLocation(node))
        )
          fail('platform global in pure viewer decision/contract: ' + node.text);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    if (
      owner === 'server' &&
      !['configuration.ts', 'adminConfiguration.ts', 'configYaml.ts', 'index.ts', 'db/maintenance.ts'].some(
        (name) => file === `packages/server/src/${name}`,
      ) &&
      /process\.env/.test(source.text)
    )
      fail('business module reads process.env');
  }
}

const cli = JSON.parse(fs.readFileSync('packages/cli/package.json', 'utf8'));

if (
  JSON.stringify(Object.keys(cli.dependencies).filter((name) => name.startsWith('@violet-map/'))) !==
  JSON.stringify(['@violet-map/core'])
)
  violations.push('CLI required project dependencies must be exactly core');

for (const name of ['render', 'storage', 'server', 'resources'])
  if (!cli.peerDependenciesMeta?.[`@violet-map/${name}`]?.optional)
    violations.push(`CLI ${name} peer must be optional`);

for (const [owner, dependencies] of Object.entries(allowed)) {
  const metadata = JSON.parse(fs.readFileSync(`packages/${owner}/package.json`, 'utf8'));
  for (const name of Object.keys(metadata.dependencies ?? {})) {
    const target = name.match(/^@violet-map\/([^/]+)/)?.[1];
    if (target && !dependencies.includes(target)) violations.push(`${owner}: forbidden manifest dependency ${name}`);
    if (owner === 'storage' && generatorDependency.test(name))
      violations.push(`storage: resource generator manifest dependency ${name}`);
    if (owner === 'web' && /^(?:react(?:-dom|-i18next)?$|@radix-ui\/)/.test(name))
      violations.push(`web: React runtime manifest dependency ${name}`);
  }
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else console.log('Package boundaries verified');
