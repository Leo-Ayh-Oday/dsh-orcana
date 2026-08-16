import {
  DSH_HEADLESS_PACKAGE,
  dshCompanionPackage,
  parseExactPackageSpec,
} from './wsl-install.js'

/** Actual modules mounted by Orcana-owned DSH profiles. */
export const DEFAULT_ORCANA_PROFILE_IMPORT_MODULES = Object.freeze([
  '@leooday/governor-core',
  '@leooday/dsh-governor',
  '@leooday/dsh-orcana-linux/native-evidence',
] as const)

export interface WslProfileExpectation {
  dependencies: Record<string, string>
  /** Required bundle subsequence; extra user bundles may exist between rows. */
  bundles: string[]
  /** Actual runtime module specifiers that must resolve/import from the profile anchor. */
  importPackages: string[]
}

export function buildWslCompanionProfileExpectation(
  dshPackage: string,
  companionName: string,
  orcanaRuntimePackages: readonly string[],
  orcanaBundlePackages: readonly string[],
  importModules: readonly string[] = DEFAULT_ORCANA_PROFILE_IMPORT_MODULES,
): WslProfileExpectation {
  const companion = dshCompanionPackage(dshPackage, companionName)
  const allDependencies = [
    companion,
    ...orcanaRuntimePackages,
    ...orcanaBundlePackages,
  ]
  const dependencies: Record<string, string> = {}
  for (const spec of allDependencies) {
    const parsed = parseExactPackageSpec(spec)
    dependencies[parsed.name] = parsed.version
  }
  const bundleNames = orcanaBundlePackages.map(spec => parseExactPackageSpec(spec).name)
  return {
    dependencies,
    bundles: [
      '@deepseek-ai/dsh-base',
      companionName,
      ...bundleNames,
    ],
    importPackages: [...importModules],
  }
}

/** Back-compatible headless profile expectation. */
export function buildWslProfileExpectation(
  dshPackage: string,
  orcanaRuntimePackages: readonly string[],
  orcanaBundlePackages: readonly string[],
  importModules: readonly string[] = DEFAULT_ORCANA_PROFILE_IMPORT_MODULES,
): WslProfileExpectation {
  return buildWslCompanionProfileExpectation(
    dshPackage,
    DSH_HEADLESS_PACKAGE,
    orcanaRuntimePackages,
    orcanaBundlePackages,
    importModules,
  )
}

/**
 * Read-only verification of one DSH profile manifest plus the actual Orcana
 * runtime modules resolved from that profile. It never calls DSH, creates a
 * profile, rewrites cordis.yml, or mutates node_modules. The import probe
 * catches export-map, optional-peer, and DSH fallback failures that a
 * config-only smoke cannot.
 */
export const PROFILE_VERIFY_NODE_SCRIPT = [
  'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{createRequire}=require("node:module"),{pathToFileURL}=require("node:url")',
  'const [profile,depsJson,bundlesJson,importsJson]=process.argv.slice(1)',
  'if(!profile||profile.includes("/")||profile.includes("\\\\")||profile==="."||profile===".."||profile==="node_modules"){console.error(`dsh-orcana: invalid profile name ${JSON.stringify(profile)}`);process.exit(64)}',
  'const home=(process.env.DSH_HOME||"").trim()||path.join(os.homedir(),".dsh")',
  'const manifestPath=path.join(home,"profiles",profile,"package.json")',
  'let raw;try{raw=fs.readFileSync(manifestPath,"utf8")}catch(error){if(error&&error.code==="ENOENT"){console.error(`dsh-orcana: profile=${profile} is not installed (${manifestPath})`);process.exit(2)}throw error}',
  'let manifest;try{manifest=JSON.parse(raw)}catch(error){console.error(`dsh-orcana: invalid profile manifest JSON at ${manifestPath}: ${error}`);process.exit(65)}',
  'const expected=JSON.parse(depsJson),requiredBundles=JSON.parse(bundlesJson),importPackages=JSON.parse(importsJson)',
  'const deps=manifest&&typeof manifest==="object"&&!Array.isArray(manifest)&&manifest.dependencies&&typeof manifest.dependencies==="object"&&!Array.isArray(manifest.dependencies)?manifest.dependencies:{}',
  'const bundles=manifest&&typeof manifest==="object"&&!Array.isArray(manifest)&&Array.isArray(manifest.dsh?.profile?.bundles)?manifest.dsh.profile.bundles:[]',
  'const problems=[]',
  'for(const [name,version] of Object.entries(expected)){if(deps[name]!==version)problems.push(`dependency ${name}: expected ${version}, found ${JSON.stringify(deps[name])}`)}',
  'let cursor=-1;for(const name of requiredBundles){const index=bundles.indexOf(name,cursor+1);if(index===-1){problems.push(`bundle order: missing ${name} after index ${cursor}`);continue}cursor=index}',
  'if(problems.length){console.error(`dsh-orcana: profile=${profile} manifest check FAILED`);for(const problem of problems)console.error(`  - ${problem}`);process.exit(66)}',
  'const requireFromProfile=createRequire(manifestPath)',
  '(async()=>{for(const name of importPackages){let resolved;try{resolved=requireFromProfile.resolve(name)}catch(error){console.error(`dsh-orcana: profile=${profile} module resolve FAILED for ${name}: ${error}`);process.exitCode=67;return}try{await import(pathToFileURL(resolved).href)}catch(error){console.error(`dsh-orcana: profile=${profile} module import FAILED for ${name}: ${error}`);process.exitCode=68;return}}console.error(`dsh-orcana: profile=${profile} manifest/module check OK (${manifestPath})`)})().catch(error=>{console.error(`dsh-orcana: profile=${profile} module probe FAILED: ${error}`);process.exitCode=68})',
].join(';')

export function profileVerifyNodeArgs(profile: string, expectation: WslProfileExpectation): string[] {
  return [
    '-e', PROFILE_VERIFY_NODE_SCRIPT,
    profile,
    JSON.stringify(expectation.dependencies),
    JSON.stringify(expectation.bundles),
    JSON.stringify(expectation.importPackages),
  ]
}

export function buildWslProfileVerifyArgs(
  profile: string,
  expectation: WslProfileExpectation,
  distro?: string,
): string[] {
  return [
    ...(distro === undefined ? [] : ['--distribution', distro]),
    '--exec', 'node',
    ...profileVerifyNodeArgs(profile, expectation),
  ]
}
