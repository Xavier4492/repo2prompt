#!/usr/bin/env node

/**
 * repo2prompt (TypeScript + ES6 + config + binary detection + table of contents + max-size + streaming version)
 *
 * Transforms a code repository into a single text file, structured for LLM.
 *
 * Supports:
 *   - Reading a configuration file (JSON or field in package.json)
 *   - Reading a .repo2promptignore (or custom name) to exclude files
 *   - CLI options (via Commander)
 *   - Streaming reading for text files
 *   - Binary file detection (scanning the first bytes)
 *   - Inclusion of metadata for binary files
 *   - Generating a numbered table of contents at the top of the file
 *   - Handling large files (> --max-size) with truncation
 *   - Clear error messages and optional debug mode
 *
 * Usage (after global npm install):
 *   $ repo2prompt [path/to/repo] [options]
 *
 * CLI Options (override config):
 *   -c, --config <file>      Path to a JSON config file (default: looks for .repo2prompt.json or package.json)
 *   -p, --preamble <file>    Preamble file (replaces default or config preamble)
 *   -o, --output <file>      Output file (default: "output.txt" or config value)
 *   -i, --ignore <file>      Name of ignore file (default: ".repo2promptignore" or config value)
 *   -m, --max-size <bytes>   Max size (in bytes) to truncate a text file (default: 1048576 = 1 MB)
 *   -d, --debug              Enable detailed logs
 *   -v, --version            Display the installed version
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { glob } from 'glob'
import { Command } from 'commander'
import { SingleBar, Presets } from 'cli-progress'

const codeDir =
  // @ts-expect-error: __dirname may not be defined in all module systems, fallback logic required
  typeof __dirname !== 'undefined' ? __dirname : _dirname(fileURLToPath(import.meta.url))

// Configuration interface describing possible user-specified options
export interface Repo2PromptConfig {
  ignoreFile?: string // Custom ignore file name/path
  preamble?: string // File to use as preamble
  output?: string // Output file name/path
  showProgress?: boolean // Whether to show progress bar (default: true)
}

/**
 * Attempts to load configuration from various sources, in order of precedence:
 *   1. Explicit path provided via CLI
 *   2. .repo2prompt.json in repository root
 *   3. "repo2prompt" field in package.json
 * If none found, returns an empty config object.
 */
export async function loadConfig(
  repoRoot: string,
  explicitConfigPath: string | null,
  debugMode: boolean,
): Promise<Repo2PromptConfig> {
  let config: Repo2PromptConfig = {}

  // If a config path was explicitly provided, load that first
  if (explicitConfigPath) {
    const absConfig = path.resolve(process.cwd(), explicitConfigPath)
    if (debugMode) console.log(`[DEBUG] Reading explicit config: ${absConfig}`)
    try {
      const raw = await fsp.readFile(absConfig, 'utf-8')
      config = JSON.parse(raw) as Repo2PromptConfig
      if (debugMode) console.log(`[DEBUG] Explicit config content:`, config)
      return config
    } catch (err: any) {
      console.error(`Error: unable to read specified config file ("${absConfig}").`)
      console.error(err.message)
      process.exit(1)
    }
  }

  // Next, look for a .repo2prompt.json file at the repository root
  const rcPath = path.join(repoRoot, '.repo2prompt.json')
  if (await fileExists(rcPath)) {
    if (debugMode) console.log(`[DEBUG] Found .repo2prompt.json at repository root.`)
    try {
      const raw = await fsp.readFile(rcPath, 'utf-8')
      config = JSON.parse(raw) as Repo2PromptConfig
      if (debugMode) console.log(`[DEBUG] .repo2prompt.json content:`, config)
      return config
    } catch (err: any) {
      console.error(`Error: invalid read of ".repo2prompt.json".`)
      console.error(err.message)
      process.exit(1)
    }
  } else if (debugMode) {
    console.log(`[DEBUG] No .repo2prompt.json found at ${rcPath}`)
  }

  // Then check package.json for a "repo2prompt" field
  const pkgJsonPath = path.join(repoRoot, 'package.json')
  if (await fileExists(pkgJsonPath)) {
    try {
      const rawPkg = await fsp.readFile(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(rawPkg) as Record<string, any>
      if (pkg.repo2prompt && typeof pkg.repo2prompt === 'object') {
        if (debugMode)
          console.log(`[DEBUG] Reading "repo2prompt" field from repository's package.json.`)
        config = pkg.repo2prompt as Repo2PromptConfig
        if (debugMode) console.log(`[DEBUG] "repo2prompt" field content:`, config)
        return config
      }
    } catch {
      // If package.json is invalid JSON, ignore and move on
    }
  }

  if (debugMode) console.log(`[DEBUG] No config found. Using default or CLI values.`)
  return config
}

/**
 * Utility to check if a given file path exists on disk
 */
export async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Reads ignore patterns from an ignore file (e.g., .repo2promptignore) and returns
 * an array of valid glob patterns, skipping comments and blank lines.
 */
export async function getIgnoreList(ignoreFilePath: string, debugMode: boolean): Promise<string[]> {
  const raw = await fsp.readFile(ignoreFilePath, 'utf-8')
  const lines = raw.split(/\r?\n/)
  const patterns: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue // Skip empty or comment lines
    let pattern = trimmed
    // On Windows, convert forward slashes to backslashes for matching
    if (os.platform() === 'win32') {
      pattern = pattern.replace(/\//g, '\\')
    }
    patterns.push(pattern)
    if (debugMode) console.log(`[DEBUG] Added ignore pattern: "${pattern}"`)
  }
  return patterns
}

/**
 * Simple heuristic to check if a file is binary by reading its first 512 bytes
 * and checking for null bytes (0x00).
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  if (path.extname(filePath).toLowerCase() === '.bin') {
    return true
  }

  try {
    const fd = await fsp.open(filePath, 'r')
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await fd.read(buffer, 0, 512, 0)
    await fd.close()
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true
      }
    }
    return false
  } catch {
    // If any error occurs (e.g., permission issues), treat as non-binary to avoid crash
    return false
  }
}

/**
 * Builds a simple numbered table of contents from the list of file paths.
 * Each entry is prefixed by its index + 1 and a period.
 */
export function buildTableOfContents(fileList: string[]): string {
  let toc = 'Table of Contents:\n'
  fileList.forEach((filePath, index) => {
    toc += `${index + 1}. ${filePath}\n`
  })
  toc += '\n'
  return toc
}

/**
 * Streams the contents of a text file to an output stream, truncating if the
 * file size exceeds maxSize. If truncated, appends a "[TRUNCATED]" marker
 * and immediately resolves.
 */
export async function streamFileWithLimit(
  absolutePath: string,
  outputStream: fs.WriteStream,
  maxSize: number,
  debugMode: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(absolutePath, { encoding: 'utf-8' })
    let bytesWritten = 0
    let truncated = false

    readStream.on('data', (chunk: string | Buffer) => {
      if (truncated) {
        // If we've already truncated, ignore any further data
        return
      }

      // Convert to Buffer if needed to measure byte length
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8')

      // If writing this chunk would exceed maxSize, write only the remaining bytes
      if (bytesWritten + chunkBuffer.length > maxSize) {
        const remaining = maxSize - bytesWritten
        // Write only the first 'remaining' bytes
        outputStream.write(chunkBuffer.slice(0, remaining))
        truncated = true

        // Immediately write the truncation marker
        outputStream.write('\n[TRUNCATED]\n')

        if (debugMode) {
          console.log(`[DEBUG] File truncated after ${maxSize} bytes at "${absolutePath}".`)
        }

        // Stop reading further and resolve the promise
        readStream.destroy()
        resolve()
      } else {
        // Otherwise, write the entire chunk
        outputStream.write(chunkBuffer)
        bytesWritten += chunkBuffer.length
      }
    })

    readStream.on('end', () => {
      // If we never truncated, resolve now
      if (!truncated) {
        resolve()
      }
      // If truncated === true, we already called resolve() in the 'data' handler
    })

    readStream.on('error', (err) => {
      reject(err)
    })
  })
}

/**
 * Iterates through all non-ignored files, writing a separator, the relative file
 * path, and either file metadata (if binary) or file content (possibly truncated).
 */
export async function writeFilesWithIndex(
  repoRoot: string,
  nonIgnoredFiles: string[],
  outputStream: fs.WriteStream,
  maxSize: number,
  debugMode: boolean,
  bar: SingleBar | null,
): Promise<void> {
  for (let idx = 0; idx < nonIgnoredFiles.length; idx++) {
    const relativePath = nonIgnoredFiles[idx]!
    const absolutePath = path.join(repoRoot, relativePath)
    try {
      const stats = await fsp.stat(absolutePath)
      const isBinary = await isBinaryFile(absolutePath)
      outputStream.write(`----[${idx + 1}]\n`)
      outputStream.write(`${relativePath}\n`)
      if (isBinary) {
        // For binary files, write metadata instead of content
        const meta = `[BINARY FILE] Size: ${stats.size} bytes, Modified: ${stats.mtime.toISOString()}`
        outputStream.write(`${meta}\n`)
        if (debugMode) console.log(`[DEBUG] Binary metadata written for: ${relativePath}`)
      } else {
        if (stats.size > maxSize) {
          if (debugMode)
            console.log(
              `[DEBUG] File ${relativePath} (${stats.size} bytes) exceeds max-size ${maxSize}. Truncating.`,
            )
        }
        await streamFileWithLimit(absolutePath, outputStream, maxSize, debugMode)
        outputStream.write('\n')
        if (debugMode) console.log(`[DEBUG] Content (or truncated) written for: ${relativePath}`)
      }
    } catch (err: any) {
      console.warn(`Warning: unable to access or read "${relativePath}". Skipping.`)
      if (debugMode) console.warn(`[DEBUG] Error detail: ${err.message}`)
      continue
    }
    if (bar) {
      bar.increment()
    }
  }
  if (bar) {
    bar.stop()
  }
}

/**
 * Main entry point: parses CLI arguments, loads config, builds ignore list,
 * collects non-ignored files, and writes the aggregated output file.
 */
export async function main(): Promise<void> {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(codeDir, '../package.json'), 'utf-8'))
  if (!pkg || !pkg.version) {
    console.error('Error: Unable to read package version.')
    process.exit(1)
  }

  const program = new Command()
  program
    .name('repo2prompt')
    .description('Transforms a repository into a text file for LLM.')
    .argument('[repoPath]', 'Repository path (default: current directory)', '.')
    .option('-c, --config <file>', 'Path to a JSON config file (e.g., .repo2prompt.json)')
    .option('-p, --preamble <file>', 'Path to a preamble file (replaces default preamble)')
    .option('-o, --output <file>', 'Path to the output file (default: "output.txt")')
    .option('-i, --ignore <file>', 'Name of the ignore file (default: ".repo2promptignore")')
    .option('-m, --max-size <bytes>', 'Max size (in bytes) to truncate a text file', '1048576')
    .option('-d, --debug', 'Debug mode (detailed logs)')
    .option('--no-progress', 'Disable the progress bar.')
    .version(pkg.version, '-v, --version', 'Display version')
    .showHelpAfterError()

  program.parse(process.argv)
  const opts = program.opts<{
    config?: string
    preamble?: string
    output?: string
    ignore?: string
    maxSize?: string
    debug?: boolean
    progress?: boolean
  }>()

  // Determine repository path and debug/maxSize options
  const repoPathInput = (program.args[0] as string) || '.'
  const debugMode = Boolean(opts.debug)
  const maxSize = parseInt(opts.maxSize || '1048576', 10) || 1048576 // Default to 1 MiB

  const repoRoot = path.resolve(process.cwd(), repoPathInput)
  if (debugMode) console.log(`[DEBUG] Resolving repository: ${repoRoot}`)

  // Verify repository path exists and is a directory
  try {
    const statsRepo = await fsp.stat(repoRoot)
    if (!statsRepo.isDirectory()) {
      console.error(`Error: "${repoRoot}" is not a directory.`)
      process.exit(1)
    }
  } catch {
    console.error(`Error: "${repoRoot}" does not exist.`)
    process.exit(1)
  }

  // Load configuration from file(s) or defaults
  const configFromFile = await loadConfig(repoRoot, opts.config ?? null, debugMode)

  let showProgress = opts.progress // true if no --no-progress
  // If the user did not specify a flag (or kept --progress by default),
  // we can override with the file config:
  if (opts.progress && typeof configFromFile.showProgress === 'boolean') {
    showProgress = configFromFile.showProgress
  }
  if (debugMode) {
    showProgress = false
  }

  // Determine ignore file, preamble, and output file names (CLI > config > default)
  const ignoreFileName = opts.ignore || configFromFile.ignoreFile || '.repo2promptignore'
  const preambleFile = opts.preamble || configFromFile.preamble || null
  const outputFileName = opts.output || configFromFile.output || 'output.txt'

  // Resolve ignore file path (considering possible fallback to script directory)
  let ignoreFilePath = path.join(repoRoot, ignoreFileName)
  if (os.platform() === 'win32') ignoreFilePath = ignoreFilePath.replace(/\//g, '\\')

  // if (!(await fileExists(ignoreFilePath))) {
  //   const fallback = path.join(codeDir, ignoreFileName)
  //   if (await fileExists(fallback)) {
  //     ignoreFilePath = fallback
  //     if (debugMode) console.log(`[DEBUG] Fallback ignore found: ${fallback}`)
  //   }
  // }

  // Read ignore patterns if the file exists
  let ignorePatterns: string[] = []
  if (await fileExists(ignoreFilePath)) {
    try {
      ignorePatterns = await getIgnoreList(ignoreFilePath, debugMode)
    } catch (err: any) {
      console.error(`Error: unable to read ignore file "${ignoreFilePath}".`)
      console.error(err.message)
      process.exit(1)
    }
  } else if (debugMode) {
    console.log(`[DEBUG] No ignore file found (expected path: ${ignoreFilePath}).`)
  }

  const positivePatterns = ignorePatterns.filter((p) => !p.startsWith('!'))
  const negativePatterns = ignorePatterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1)) // remove the '!' for direct matching

  const ignoreGlobs: string[] = [
    ...positivePatterns,
    '.git/**',
    'node_modules/**',
    ignoreFileName,
    outputFileName,
    preambleFile || '',
  ].filter(Boolean)

  // 4. First list files by applying ignoreGlobs
  let allFiles: string[] = []
  try {
    allFiles = await glob('**/*', {
      cwd: repoRoot,
      nodir: true,
      dot: true,
      follow: false,
      ignore: ignoreGlobs,
    })
    if (debugMode) console.log(`[DEBUG] ${allFiles.length} files after positive ignore`)
  } catch (err: any) {
    console.error('Error while building the file list.')
    console.error(err)
    process.exit(1)
  }

  // 5. For each negative pattern, gather matching files
  let reIncluded: string[] = []
  for (const pat of negativePatterns) {
    try {
      const matches = await glob(pat, {
        cwd: repoRoot,
        nodir: true,
        dot: true,
        follow: false,
      })
      reIncluded.push(...matches)
    } catch (err: any) {
      if (debugMode) console.warn(`[DEBUG] Invalid negative pattern "${pat}": ${err.message}`)
    }
  }

  const mergedSet = new Set<string>(allFiles)
  for (const f of reIncluded) {
    mergedSet.add(f)
  }

  // 7. Exclude ignoreFileName / outputFileName / preambleFile again just in case
  mergedSet.delete(ignoreFileName)
  mergedSet.delete(outputFileName)
  if (preambleFile) mergedSet.delete(preambleFile)

  const nonIgnoredFiles = Array.from(mergedSet)
  if (debugMode) console.log(`[DEBUG] ${nonIgnoredFiles.length} files after re-include`)

  // Loading bar for progress indication
  let bar: SingleBar | null = null
  if (showProgress) {
    const totalFiles = nonIgnoredFiles.length
    bar = new SingleBar(
      {
        format: 'Processing files |' + '{bar}' + '| {value}/{total} files',
      },
      Presets.shades_classic,
    )
    bar.start(totalFiles, 0)
  }

  // Load custom or default preamble text
  let preambleText = ''
  if (preambleFile) {
    const absPreamble = path.resolve(process.cwd(), preambleFile)
    try {
      preambleText = await fsp.readFile(absPreamble, 'utf-8')
      if (!preambleText.endsWith('\n')) preambleText += '\n'
      if (debugMode) console.log(`[DEBUG] Custom preamble loaded (${absPreamble}).`)
    } catch {
      console.error(`Error: unable to read preamble "${absPreamble}".`)
      process.exit(1)
    }
  } else if (configFromFile.preamble) {
    const absPreamble = path.resolve(repoRoot, configFromFile.preamble!)
    try {
      preambleText = await fsp.readFile(absPreamble, 'utf-8')
      if (!preambleText.endsWith('\n')) preambleText += '\n'
      if (debugMode) console.log(`[DEBUG] Preamble from config loaded ("${absPreamble}").`)
    } catch {
      console.error(`Error: unable to read preamble from config ("${absPreamble}").`)
      process.exit(1)
    }
  } else {
    // Default preamble explaining format for LLM ingestion
    preambleText =
      'The following is a snapshot of a Git repository, rendered as a plain-text “dump” for use by a language model. ' +
      'It is structured in three parts:\n\n' +
      '1. **Table of Contents:**\n' +
      '   A numbered list of every file included, in the order they appear below.\n\n' +
      '2. **File Sections:**\n' +
      '   Each file is prefixed by:\n\n' +
      '   ----[N]\n' +
      '   <relative/path/to/file>\n\n' +
      '   where `N` is the file’s index (matching the ToC). After that line comes the file’s contents (or, if it’s binary or too large, ' +
      'a brief metadata/truncation marker).\n\n' +
      '3. **End Marker:**\n' +
      '   A final line containing `--END--` indicates the end of the repository snapshot. Any text that follows should be treated ' +
      'as instructions or queries about this repository.\n\n' +
      'Use this entire dump as context when answering questions. For example, you can reference specific files by their ToC number ' +
      'or path, inspect code snippets, identify configuration values, and so on.\n\n' +
      '---\n\n'

    if (debugMode) console.log('[DEBUG] Using default preamble.')
  }

  // Prepare output stream for writing repository content
  const outputPath = path.resolve(process.cwd(), outputFileName)
  let outputStream: fs.WriteStream
  try {
    outputStream = fs.createWriteStream(outputPath, { flags: 'w', encoding: 'utf-8' })
  } catch (err: any) {
    console.error(`Error: unable to open "${outputPath}" for writing.`)
    console.error(err.message)
    process.exit(1)
  }
  if (debugMode) console.log(`[DEBUG] Output file ready: ${outputPath}`)

  // Write preamble and table of contents, then file contents with indexing
  outputStream.write(preambleText)
  const toc = buildTableOfContents(nonIgnoredFiles)
  outputStream.write(toc)
  if (debugMode) console.log(`[DEBUG] Table of contents written.`)

  try {
    await writeFilesWithIndex(repoRoot, nonIgnoredFiles, outputStream, maxSize, debugMode, bar)
  } catch (err: any) {
    console.error('Unexpected error while writing indexed files:')
    console.error(err)
    outputStream.close()
    process.exit(1)
  }

  // Mark end of repository snapshot
  outputStream.write('--END--\n')
  outputStream.end()

  console.log(`✅ Repository content written to: ${outputPath}`)
}
