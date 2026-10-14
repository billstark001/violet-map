import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const allowed = {
  core: [],
  render: ['core'],
  storage: ['core'],
  server: ['core', 'storage'],
  web: ['core', 'render'],
  admin: ['core'],
  cli: ['core', 'render', 'storage', 'server'],
};
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(dir, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [path.join(dir, entry.name)]
          : [],
    );
}
const violations = [];
for (const [owner, dependencies] of Object.entries(allowed)) {
  for (const file of files(`packages/${owner}/src`)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
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
            ? path.resolve(path.dirname(file), name).match(/\/packages\/([^/]+)\//)?.[1]
            : undefined);
        if (target && target !== owner && !dependencies.includes(target)) fail(`forbidden dependency ${name}`);
        if (owner === 'cli' && ['render', 'storage', 'server'].includes(target)) {
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
        if (owner === 'core' && /^(?:node:)?(?:fs|path)(?:\/|$)|^@aws-sdk\//.test(name))
          fail(`platform implementation ${name}`);
        if (owner === 'render' && /^(node:|(?:fs|path|buffer)(?:\/|$)|three(?:\/|$)|@aws-sdk\/)/.test(name))
          fail(`platform implementation ${name}`);
        if (
          ['web', 'admin'].includes(owner) &&
          /^(node:|@aws-sdk\/|pg$|drizzle-orm(?:\/|$)|@electric-sql\/)/.test(name)
        )
          fail(`server implementation ${name}`);
        if (owner === 'admin' && target === 'core' && !['@violet-map/core/contracts'].includes(name))
          fail(`heavy admin entry ${name}`);
      }
      if (
        owner === 'render' &&
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
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    if (
      owner === 'server' &&
      !['configuration.ts', 'configYaml.ts', 'index.ts', 'db/maintenance.ts'].some(
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
for (const name of ['render', 'storage', 'server'])
  if (!cli.peerDependenciesMeta?.[`@violet-map/${name}`]?.optional)
    violations.push(`CLI ${name} peer must be optional`);
for (const [owner, dependencies] of Object.entries(allowed)) {
  const metadata = JSON.parse(fs.readFileSync(`packages/${owner}/package.json`, 'utf8'));
  for (const name of Object.keys(metadata.dependencies ?? {})) {
    const target = name.match(/^@violet-map\/([^/]+)/)?.[1];
    if (target && !dependencies.includes(target)) violations.push(`${owner}: forbidden manifest dependency ${name}`);
  }
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else console.log('Package boundaries verified');
