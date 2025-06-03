// tests/all.test.ts

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest'
import { glob } from 'glob'
import { SingleBar } from 'cli-progress'

import * as indexModule from '../src/index'
import {
  loadConfig,
  fileExists,
  getIgnoreList,
  isBinaryFile,
  buildTableOfContents,
  streamFileWithLimit,
  writeFilesWithIndex,
  Repo2PromptConfig,
  main,
} from '../src/index'

// -----------------------------------------------------------------------------
// Helpers for temporary directories/files
// -----------------------------------------------------------------------------
const TMP_ROOT = path.join(os.tmpdir(), 'repo2prompt-tests')
const ensureTmpDir = async () => {
  await fsp.rm(TMP_ROOT, { recursive: true, force: true })
  await fsp.mkdir(TMP_ROOT, { recursive: true })
}
const cleanTmpDir = async () => {
  await fsp.rm(TMP_ROOT, { recursive: true, force: true })
}

// -----------------------------------------------------------------------------
// Tests for utility functions in src/index.ts
// -----------------------------------------------------------------------------
describe('Utility functions in src/index.ts', () => {
  beforeAll(async () => {
    await ensureTmpDir()
  })
  afterAll(async () => {
    await cleanTmpDir()
  })

  it('buildTableOfContents produces a correctly numbered table of contents', () => {
    const files = ['foo.txt', 'bar/baz.js', 'qux/quux.txt']
    const toc = buildTableOfContents(files)
    const expectedLines = ['Table of Contents:', '1. foo.txt', '2. bar/baz.js', '3. qux/quux.txt']
    expectedLines.forEach((line) => {
      expect(toc).toContain(line)
    })
    expect(toc.endsWith('\n\n')).toBe(true)
  })

  it('buildTableOfContents handles an empty list', () => {
    const toc = buildTableOfContents([])
    expect(toc).toBe('Table of Contents:\n\n')
  })

  it('fileExists returns true if the file exists, false otherwise', async () => {
    const existing = path.join(TMP_ROOT, 'exists.txt')
    await fsp.writeFile(existing, 'hello')
    expect(await fileExists(existing)).toBe(true)
    expect(await fileExists(path.join(TMP_ROOT, 'nope.txt'))).toBe(false)
  })

  it('getIgnoreList filters out comments and blank lines', async () => {
    const ignoreFile = path.join(TMP_ROOT, '.repo2promptignore_test')
    const content = `
# This is a comment
foo.js

bar/*.txt
# Another comment

baz/**/qux.txt
    `
    await fsp.writeFile(ignoreFile, content.trim())
    const patterns = await getIgnoreList(ignoreFile, false)
    expect(patterns).toEqual(['foo.js', 'bar/*.txt', 'baz/**/qux.txt'])
  })

  it('isBinaryFile correctly detects a text file and a binary file', async () => {
    const textFile = path.join(TMP_ROOT, 'file.txt')
    const binFile = path.join(TMP_ROOT, 'file.bin')
    // Text file
    await fsp.writeFile(textFile, 'This is plain text without a null byte.')
    expect(await isBinaryFile(textFile)).toBe(false)
    // Binary file (some non-ASCII bytes)
    const buf = Buffer.from([0, 159, 146, 150])
    await fsp.writeFile(binFile, buf)
    expect(await isBinaryFile(binFile)).toBe(true)
    // A file with .BIN extension but containing text
    const anotherBin = path.join(TMP_ROOT, 'another.BIN')
    await fsp.writeFile(anotherBin, 'some text')
    expect(await isBinaryFile(anotherBin)).toBe(true)
  })

  it('isBinaryFile returns false if the file is inaccessible and does not have .bin extension', async () => {
    // Point to a nonexistent .txt file: should not throw, just return false
    expect(await isBinaryFile(path.join(TMP_ROOT, 'nonexistent.txt'))).toBe(false)
  })

  it('streamFileWithLimit writes and truncates when needed', async () => {
    const longFile = path.join(TMP_ROOT, 'long.txt')
    // Write 500 'A's + 500 'B's (1000 bytes)
    const content = 'A'.repeat(500) + 'B'.repeat(500)
    await fsp.writeFile(longFile, content)
    // Simulate maxSize = 800 bytes
    const outputTemp = path.join(TMP_ROOT, 'out.txt')
    const ws = fs.createWriteStream(outputTemp, { encoding: 'utf-8' })
    await streamFileWithLimit(longFile, ws, 800, false)
    ws.end()
    await new Promise<void>((resolve) => ws.on('finish', resolve))

    const result = await fsp.readFile(outputTemp, 'utf-8')
    // Since we read a 1000-byte chunk at once, we truncate at 800 => 500 'A's + 300 'B's
    expect(result).toMatch(/^A{500}B{300}/)
    expect(result).toContain('[TRUNCATED]')
  })

  it('streamFileWithLimit writes full content when size < maxSize without [TRUNCATED]', async () => {
    const smallFile = path.join(TMP_ROOT, 'small.txt')
    const content = 'X'.repeat(100)
    await fsp.writeFile(smallFile, content)

    const outputTemp = path.join(TMP_ROOT, 'out_small.txt')
    const ws = fs.createWriteStream(outputTemp, { encoding: 'utf-8' })
    await streamFileWithLimit(smallFile, ws, 200, false) // maxSize=200
    ws.end()
    await new Promise<void>((resolve) => ws.on('finish', resolve))

    const result = await fsp.readFile(outputTemp, 'utf-8')
    expect(result).toBe(content)
    expect(result).not.toContain('[TRUNCATED]')
  })

  it('loadConfig prioritizes: explicit config > .repo2prompt.json > package.json > default', async () => {
    const repoDir = path.join(TMP_ROOT, 'repoConfig')
    await fsp.mkdir(repoDir, { recursive: true })

    // 1) explicitConfigPath
    const explicitCfg = path.join(repoDir, 'explicit.json')
    const explicitObj: Repo2PromptConfig = { output: 'file.txt', showProgress: false }
    await fsp.writeFile(explicitCfg, JSON.stringify(explicitObj))
    const cfg1 = await loadConfig(repoDir, explicitCfg, false)
    expect(cfg1.output).toBe('file.txt')
    expect(cfg1.showProgress).toBe(false)

    // 2) .repo2prompt.json
    const rcPath = path.join(repoDir, '.repo2prompt.json')
    const rcObj: Repo2PromptConfig = { ignoreFile: 'myignore', preamble: 'preamble.txt' }
    await fsp.writeFile(rcPath, JSON.stringify(rcObj))
    const cfg2 = await loadConfig(repoDir, null, false)
    expect(cfg2.ignoreFile).toBe('myignore')
    expect(cfg2.preamble).toBe('preamble.txt')

    // 3) package.json with repo2prompt field
    await fsp.rm(rcPath, { force: true })
    const pkg = {
      name: 'test',
      version: '1.0.0',
      repo2prompt: { output: 'fromPackage.txt', showProgress: true },
    }
    await fsp.writeFile(path.join(repoDir, 'package.json'), JSON.stringify(pkg))
    const cfg3 = await loadConfig(repoDir, null, false)
    expect(cfg3.output).toBe('fromPackage.txt')
    expect(cfg3.showProgress).toBe(true)

    // 4) No config files, returns {}
    await fsp.rm(path.join(repoDir, 'package.json'), { force: true })
    const cfg4 = await loadConfig(repoDir, null, false)
    expect(cfg4).toEqual({})
  })

  it('loadConfig exits if explicitConfig is invalid JSON', async () => {
    const repoDir = path.join(TMP_ROOT, 'invalidConfig')
    await fsp.mkdir(repoDir, { recursive: true })
    const badFile = path.join(repoDir, 'bad.json')
    await fsp.writeFile(badFile, '{invalidJson}') // Invalid JSON

    const exitSpy = vi.spyOn(process, 'exit').mockImplementationOnce(((code?: number) => {
      throw new Error(`process.exit: ${code}`)
    }) as never)

    await expect(loadConfig(repoDir, badFile, false)).rejects.toThrow(/process\.exit: 1/)

    exitSpy.mockRestore()
  })

  it('loadConfig returns {} if package.json exists without repo2prompt field', async () => {
    const repoDir = path.join(TMP_ROOT, 'pkgNoField')
    await fsp.mkdir(repoDir, { recursive: true })
    const pkg = { name: 'test', version: '1.0.0' }
    await fsp.writeFile(path.join(repoDir, 'package.json'), JSON.stringify(pkg))

    const cfg = await loadConfig(repoDir, null, false)
    expect(cfg).toEqual({})
  })

  it('getIgnoreList handles negative patterns and re-includes files correctly', async () => {
    const repoDir = path.join(TMP_ROOT, 'ignoreTests')
    await fsp.mkdir(repoDir, { recursive: true })
    const ignoreContent = 'foo.ts\n!bar.ts'
    await fsp.writeFile(path.join(repoDir, '.repo2promptignore'), ignoreContent)
    // Create files
    await fsp.writeFile(path.join(repoDir, 'foo.ts'), 'export const a = 1;')
    await fsp.writeFile(path.join(repoDir, 'bar.ts'), 'export const b = 2;')
    await fsp.writeFile(path.join(repoDir, 'baz.js'), 'console.log("ok");')

    const patterns = await getIgnoreList(path.join(repoDir, '.repo2promptignore'), false)
    const positive = patterns.filter((p) => !p.startsWith('!'))
    const negative = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1))

    // Files after applying positive ignores
    const allIgnored = await glob('**/*', {
      cwd: repoDir,
      nodir: true,
      ignore: [...positive],
    })
    // Re-include via negative
    let reincluded: string[] = []
    if (negative[0]) {
      reincluded = await glob(negative[0], { cwd: repoDir, nodir: true })
    }
    const set = new Set<string>(allIgnored)
    reincluded.forEach((f) => set.add(f))
    const result = Array.from(set)

    expect(result).toContain('bar.ts') // re-included
    expect(result).not.toContain('foo.ts') // ignored
    expect(result).toContain('baz.js') // unaffected
  })

  it('writeFilesWithIndex outputs correct sections for text and binary files', async () => {
    const repoDir = path.join(TMP_ROOT, 'repoWriteTest')
    await fsp.mkdir(repoDir, { recursive: true })
    const textPath = path.join(repoDir, 'text.txt')
    const binPath = path.join(repoDir, 'image.bin')
    await fsp.writeFile(textPath, 'Test content')
    const binBuf = Buffer.from([0, 1, 2, 3, 4, 0])
    await fsp.writeFile(binPath, binBuf)

    const outFile = path.join(repoDir, 'out.txt')
    const ws = fs.createWriteStream(outFile, { encoding: 'utf-8' })
    await writeFilesWithIndex(repoDir, ['text.txt', 'image.bin'], ws, 1024, false, null)
    ws.end()
    await new Promise<void>((resolve) => ws.on('finish', resolve))

    const result = await fsp.readFile(outFile, 'utf-8')
    expect(result).toContain('----[1]\ntext.txt\n')
    expect(result).toContain('Test content')
    expect(result).toContain('----[2]\nimage.bin\n')
    expect(result).toMatch(/\[BINARY FILE\] Size: \d+ bytes, Modified: .+/)
  })

  it('writeFilesWithIndex ignores inaccessible files without throwing an error', async () => {
    const repoDir = path.join(TMP_ROOT, 'repoWriteInaccessible')
    await fsp.mkdir(repoDir, { recursive: true })
    // Provide a nonexistent file
    const outFile = path.join(repoDir, 'out_inaccessible.txt')
    const ws = fs.createWriteStream(outFile, { encoding: 'utf-8' })
    await writeFilesWithIndex(repoDir, ['nonexistent.txt'], ws, 1024, false, null)
    ws.end()
    await new Promise<void>((resolve) => ws.on('finish', resolve))
    const result = await fsp.readFile(outFile, 'utf-8')
    expect(result).toBe('')
  })

  it('writeFilesWithIndex truncates a large text file and adds [TRUNCATED]', async () => {
    const repoDir = path.join(TMP_ROOT, 'repoWriteTruncate')
    await fsp.mkdir(repoDir, { recursive: true })
    const largeContent = 'Z'.repeat(500) + 'Y'.repeat(500) // 1000 bytes
    const largeFile = path.join(repoDir, 'large.txt')
    await fsp.writeFile(largeFile, largeContent)

    const outFile = path.join(repoDir, 'out_truncate.txt')
    const ws = fs.createWriteStream(outFile, { encoding: 'utf-8' })
    await writeFilesWithIndex(repoDir, ['large.txt'], ws, 800, false, null)
    ws.end()
    await new Promise<void>((resolve) => ws.on('finish', resolve))

    const result = await fsp.readFile(outFile, 'utf-8')
    // Check that we truncated after 800 bytes (500 Z + 300 Y) and added [TRUNCATED]
    expect(result).toMatch(new RegExp('Z{500}Y{300}'))
    expect(result).toContain('[TRUNCATED]')
  })
})

// -----------------------------------------------------------------------------
// Tests for the repo2prompt CLI (integration tests)
// -----------------------------------------------------------------------------
describe('repo2prompt CLI integration tests', () => {
  // Intercept any fs.readFileSync for node_modules/tinypool/.../package.json
  const realReadFileSync = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((p: any, opts: any) => {
    if (
      typeof p === 'string' &&
      p.includes('node_modules/tinypool') &&
      p.endsWith('package.json')
    ) {
      const projectPkg = path.resolve(__dirname, '../package.json')
      return realReadFileSync(projectPkg, opts)
    }
    return realReadFileSync(p, opts)
  })

  const TMP_CLI_ROOT = path.join(os.tmpdir(), 'repo2prompt-test')

  // Helper to recursively copy a directory
  async function copyDir(srcDir: string, destDir: string): Promise<void> {
    await fsp.mkdir(destDir, { recursive: true })
    const entries = await fsp.readdir(srcDir, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name)
      const destPath = path.join(destDir, entry.name)
      if (entry.isDirectory()) {
        await copyDir(srcPath, destPath)
      } else {
        await fsp.copyFile(srcPath, destPath)
      }
    }
  }

  beforeAll(async () => {
    // Ensure a clean temporary directory
    await fsp.rm(TMP_CLI_ROOT, { recursive: true, force: true })
    await fsp.mkdir(TMP_CLI_ROOT, { recursive: true })
  })

  afterAll(async () => {
    // Cleanup
    await fsp.rm(TMP_CLI_ROOT, { recursive: true, force: true })
  })

  test('Basic functionality on basic-repo fixture', async () => {
    const fixture: string = path.join(__dirname, 'fixtures/basic-repo')
    const workingDir: string = path.join(TMP_CLI_ROOT, 'basic-repo-copy')

    // Copy the test repo into a temp folder
    await copyDir(fixture, workingDir)

    // Simulate cwd and CLI argument
    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(workingDir)
      process.argv = ['node', 'repo2prompt', workingDir]
      await main()
    } catch (err) {
      throw err
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }

    // Verify that output.txt was created
    const outputPath: string = path.join(workingDir, 'output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)

    const content: string = await fsp.readFile(outputPath, 'utf-8')

    // 1) README.md should appear in the table of contents
    expect(content).toMatch(/Table of Contents:[\s\S]*README\.md/)
    // 2) large-file.txt should be truncated and contain “[TRUNCATED]”
    expect(content).toMatch(/large-file\.txt[\s\S]*\[TRUNCATED\]/)
    // 3) small-script.js is ignored (due to .repo2promptignore)
    expect(content).not.toMatch(/small-script\.js/)
    // 4) bin-file.bin appears as metadata (no text content)
    expect(content).toMatch(/bin-file\.bin[\s\S]*\[BINARY FILE\]/)
  })

  test('Complete .repo2promptignore behavior (ignore-only-repo fixture)', async () => {
    const fixture: string = path.join(__dirname, 'fixtures/ignore-only-repo')
    const workingDir: string = path.join(TMP_CLI_ROOT, 'ignore-only-repo-copy')

    await copyDir(fixture, workingDir)

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(workingDir)
      process.argv = ['node', 'repo2prompt', workingDir]
      await main()
    } catch (err) {
      throw err
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }

    const outputPath: string = path.join(workingDir, 'output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)

    const content: string = await fsp.readFile(outputPath, 'utf-8')

    // We should only see kept.txt, no other files
    expect(content).toMatch(/Table of Contents:[\s\S]*1\. kept\.txt/)
    // No mention of "*" or empty directories
    expect(content).not.toMatch(/\*\./)
  })
})

// -----------------------------------------------------------------------------
// Tests for main() command-line behavior
// -----------------------------------------------------------------------------
describe('CLI main() behavior and edge cases', () => {
  const TMP_MAIN_ROOT = path.join(os.tmpdir(), 'repo2prompt-main-tests')

  // Intercept fs.readFileSync to always return project package.json
  const realReadFileSync = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((p: any, opts: any) => {
    if (typeof p === 'string' && p.endsWith('package.json')) {
      const projectPkg = path.resolve(__dirname, '../package.json')
      return realReadFileSync(projectPkg, opts)
    }
    return realReadFileSync(p, opts)
  })

  // Utility to capture process.exit and console.error
  function mockExitAndError() {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit: ${code}`)
    }) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    return { exitSpy, errorSpy }
  }

  beforeAll(async () => {
    await fsp.rm(TMP_MAIN_ROOT, { recursive: true, force: true })
    await fsp.mkdir(TMP_MAIN_ROOT, { recursive: true })
  })
  afterAll(async () => {
    await fsp.rm(TMP_MAIN_ROOT, { recursive: true, force: true })
    // Do NOT restore all mocks here; we need to keep fs.readFileSync stubbed
  })

  it('should exit if the repo path does not exist', async () => {
    const { exitSpy, errorSpy } = mockExitAndError()
    const nonExistent = path.join(TMP_MAIN_ROOT, 'does-not-exist')
    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(TMP_MAIN_ROOT)
      process.argv = ['node', 'repo2prompt', nonExistent]
      await expect(main()).rejects.toThrow(/process\.exit: 1/)
      expect(errorSpy).toHaveBeenCalledWith(`Error: "${path.resolve(nonExistent)}" does not exist.`)
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      process.argv = originalArgv
      process.chdir(originalCwd)
    }
  })

  it('should exit if the repo path exists but is not a directory', async () => {
    const { exitSpy, errorSpy } = mockExitAndError()
    const fakeFile = path.join(TMP_MAIN_ROOT, 'not-a-dir.txt')
    await fsp.writeFile(fakeFile, 'dummy')
    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(TMP_MAIN_ROOT)
      process.argv = ['node', 'repo2prompt', fakeFile]
      await expect(main()).rejects.toThrow(/process\.exit: 1/)
      expect(errorSpy).toHaveBeenCalledWith(
        `Error: "${path.resolve(fakeFile)}" is not a directory.`,
      )
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      process.argv = originalArgv
      process.chdir(originalCwd)
    }
  })

  it('honors --preamble and displays the content of the preamble file at the top', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-with-preamble')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    await fsp.writeFile(path.join(repoDir, 'foo.txt'), 'hello')

    const preamblePath = path.join(repoDir, 'my-preamble.txt')
    const preambleContent = 'This is the custom preamble.\nSecond line.\n'
    await fsp.writeFile(preamblePath, preambleContent)

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir, '--preamble', preamblePath]
      await main()
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }

    const outputPath = path.join(repoDir, 'output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)
    const content = await fsp.readFile(outputPath, 'utf-8')
    // Preamble should appear at the very beginning
    expect(content.startsWith(preambleContent)).toBe(true)
    expect(content).toMatch(/Table of Contents:/)
  })

  it('honors --config and overrides default values', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-with-config')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    await fsp.writeFile(path.join(repoDir, 'keep.txt'), 'KEEP')
    await fsp.writeFile(path.join(repoDir, 'skip.txt'), 'SKIP')

    // Create a config file "my-config.json"
    const cfgObj = { ignoreFile: '.customignore', output: 'custom-output.txt' }
    const cfgPath = path.join(repoDir, 'my-config.json')
    await fsp.writeFile(cfgPath, JSON.stringify(cfgObj))

    // Create ".customignore" to ignore keep.txt
    const ignorePath = path.join(repoDir, '.customignore')
    await fsp.writeFile(ignorePath, 'keep.txt\n')

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir, '--config', cfgPath]
      await main()
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }

    const outputPath = path.join(repoDir, 'custom-output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)
    const content = await fsp.readFile(outputPath, 'utf-8')
    expect(content).toMatch(/skip\.txt/)
    expect(content).not.toMatch(/keep\.txt/)
  })

  it('displays the default preamble if no preamble file is provided', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-default-preamble')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    await fsp.writeFile(path.join(repoDir, 'a.txt'), 'AAA')

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir]
      await main()
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }

    const outputPath = path.join(repoDir, 'output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)
    const content = await fsp.readFile(outputPath, 'utf-8')
    expect(content).toMatch(/The following is a snapshot of a Git repository/)
    expect(content).toMatch(/Table of Contents:/)
  })

  it('exits if the explicit preamble file is invalid/inaccessible', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-bad-preamble')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    await fsp.writeFile(path.join(repoDir, 'foo.txt'), 'FOO')

    const badPreamble = path.join(repoDir, 'nonexistent.txt')
    const { exitSpy, errorSpy } = mockExitAndError()
    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir, '--preamble', badPreamble]
      await expect(main()).rejects.toThrow(/process\.exit: 1/)
      expect(errorSpy).toHaveBeenCalledWith(
        `Error: unable to read preamble "${path.resolve(badPreamble)}".`,
      )
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      process.argv = originalArgv
      process.chdir(originalCwd)
    }
  })

  it('exits correctly when an invalid config (malformed JSON) is passed via --config', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-bad-config')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    const badCfgPath = path.join(repoDir, 'bad.json')
    await fsp.writeFile(badCfgPath, '{invalidJson}')

    const { exitSpy, errorSpy } = mockExitAndError()
    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir, '--config', badCfgPath]
      await expect(main()).rejects.toThrow(/process\.exit: 1/)
      expect(errorSpy).toHaveBeenCalledWith(
        `Error: unable to read specified config file ("${path.resolve(badCfgPath)}").`,
      )
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      process.argv = originalArgv
      process.chdir(originalCwd)
    }
  })

  it('correctly re-includes files via negative patterns in .repo2promptignore', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-negative-pattern')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    await fsp.writeFile(path.join(repoDir, 'foo.ts'), 'export const foo = 1;')
    await fsp.writeFile(path.join(repoDir, 'bar.ts'), 'export const bar = 2;')
    await fsp.writeFile(path.join(repoDir, 'baz.js'), 'console.log("baz");')

    const ignoreContent = 'foo.ts\n!bar.ts'
    await fsp.writeFile(path.join(repoDir, '.repo2promptignore'), ignoreContent)

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir]
      await main()
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }

    const outputPath = path.join(repoDir, 'output.txt')
    const content = await fsp.readFile(outputPath, 'utf-8')
    expect(content).toMatch(/bar\.ts/)
    expect(content).not.toMatch(/foo\.ts/)
    expect(content).toMatch(/baz\.js/)
  })

  it('writes the marker "--END--" at the end of the dump', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-end-marker')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    await fsp.writeFile(path.join(repoDir, 'a.txt'), 'AAA')

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir]
      await main()
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }

    const outputPath = path.join(repoDir, 'output.txt')
    const content = await fsp.readFile(outputPath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines[lines.length - 1]).toBe('--END--')
  })

  it('exits if .repo2prompt.json preamble points to a missing file', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-bad-rc-preamble')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    // Create .repo2prompt.json with invalid preamble
    const rcObj = { preamble: 'missing.txt' }
    await fsp.writeFile(path.join(repoDir, '.repo2prompt.json'), JSON.stringify(rcObj))
    // Create a dummy file
    await fsp.writeFile(path.join(repoDir, 'x.txt'), 'x')

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    const { exitSpy, errorSpy } = mockExitAndError()
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir]
      await expect(main()).rejects.toThrow(/process\.exit: 1/)
      const absPreamble = path.resolve(repoDir, 'missing.txt')
      expect(errorSpy).toHaveBeenCalledWith(`Error: unable to read preamble "${absPreamble}".`)
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      process.argv = originalArgv
      process.chdir(originalCwd)
    }
  })

  it('works with --no-progress (no progress bar)', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-no-progress')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    // Create multiple files to exercise writeFilesWithIndex
    for (let i = 1; i <= 3; i++) {
      await fsp.writeFile(path.join(repoDir, `file${i}.txt`), 'content')
    }
    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir, '--no-progress']
      await main()
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }
    const outputPath = path.join(repoDir, 'output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)
    const content = await fsp.readFile(outputPath, 'utf-8')
    // Should contain all three files
    expect(content).toMatch(/file1\.txt/)
    expect(content).toMatch(/file2\.txt/)
    expect(content).toMatch(/file3\.txt/)
  })

  it('continues even if .repo2promptignore contains an invalid pattern', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-invalid-ignore')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    // A file to include
    await fsp.writeFile(path.join(repoDir, 'good.txt'), 'ok')
    // .repo2promptignore with invalid pattern
    await fsp.writeFile(path.join(repoDir, '.repo2promptignore'), '[')

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir]
      await main()
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }
    const outputPath = path.join(repoDir, 'output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)
    const content = await fsp.readFile(outputPath, 'utf-8')
    // The file "good.txt" should still appear
    expect(content).toMatch(/good\.txt/)
  })

  it('honors --ignore CLI option to ignore files', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-cli-ignore')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })
    await fsp.writeFile(path.join(repoDir, 'keep.txt'), 'K')
    await fsp.writeFile(path.join(repoDir, 'skip.txt'), 'S')
    // Create a custom ignore file named ".myignore"
    await fsp.writeFile(path.join(repoDir, '.myignore'), 'skip.txt\n')

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir, '--ignore', '.myignore']
      await main()
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }
    const outputPath = path.join(repoDir, 'output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)
    const content = await fsp.readFile(outputPath, 'utf-8')
    expect(content).toMatch(/keep\.txt/)
    expect(content).not.toMatch(/skip\.txt/)
  })

  it('uses ignoreFile and output from package.json repo2prompt field', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-pkgjson-ignore-output')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })

    // Create two files
    await fsp.writeFile(path.join(repoDir, 'keep.txt'), 'KEEP')
    await fsp.writeFile(path.join(repoDir, 'skip.txt'), 'SKIP')

    // Create an ignore file named ".pkgignore" that ignores "skip.txt"
    await fsp.writeFile(path.join(repoDir, '.pkgignore'), 'skip.txt\n')

    // Create package.json with repo2prompt.ignoreFile and output
    const pkgObj = {
      name: 'test-pkg-ignore',
      version: '1.0.0',
      repo2prompt: {
        ignoreFile: '.pkgignore',
        output: 'pkg-output.txt',
      },
    }
    await fsp.writeFile(path.join(repoDir, 'package.json'), JSON.stringify(pkgObj))

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      // No --ignore or --output on CLI: should use package.json values
      process.argv = ['node', 'repo2prompt', repoDir]
      await main()
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }

    // Expect the generated file to be "pkg-output.txt"
    const outputPath = path.join(repoDir, 'pkg-output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)

    const content = await fsp.readFile(outputPath, 'utf-8')
    // "skip.txt" should be ignored, "keep.txt" should appear
    expect(content).toMatch(/keep\.txt/)
    expect(content).not.toMatch(/skip\.txt/)
  })

  it('writes "[BINARY FILE]" metadata for a .bin file', async () => {
    const repoDir = path.join(TMP_MAIN_ROOT, 'repo-binary-file')
    await fsp.rm(repoDir, { recursive: true, force: true })
    await fsp.mkdir(repoDir, { recursive: true })

    // Create a small binary file (extension .bin is sufficient for isBinaryFile)
    const binPath = path.join(repoDir, 'test.bin')
    await fsp.writeFile(binPath, Buffer.from([0, 1, 2, 3, 4, 5]))

    // Create a text file to ensure TOC is not empty
    await fsp.writeFile(path.join(repoDir, 'foo.txt'), 'foo')

    const originalCwd = process.cwd()
    const originalArgv = process.argv
    try {
      process.chdir(repoDir)
      process.argv = ['node', 'repo2prompt', repoDir]
      await main()
    } finally {
      process.argv = originalArgv
      process.chdir(originalCwd)
    }

    const outputPath = path.join(repoDir, 'output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)

    const content = await fsp.readFile(outputPath, 'utf-8')
    // Verify the "test.bin" section contains "[BINARY FILE]"
    expect(content).toMatch(/test\.bin[\s\S]*\[BINARY FILE\]/)
    // Also verify that size in bytes and "Modified: " appear
    expect(content).toMatch(/\[BINARY FILE\] Size: \d+ bytes, Modified: .+/)
  })
})

// -----------------------------------------------------------------------------
// Additional unit tests for loadConfig, getIgnoreList, isBinaryFile, ...
// -----------------------------------------------------------------------------
describe('Additional coverage for loadConfig', () => {
  const TMP = path.join(os.tmpdir(), 'repo2prompt-loadConfig')

  beforeEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true })
    await fsp.mkdir(TMP, { recursive: true })
  })

  it('returns {} if there is no .repo2prompt.json or package.json', async () => {
    const cfg = await loadConfig(TMP, null, false)
    expect(cfg).toEqual({})
  })

  it('returns {} if package.json exists without repo2prompt field', async () => {
    const pkg = { name: 'no-field', version: '1.0.0' }
    await fsp.writeFile(path.join(TMP, 'package.json'), JSON.stringify(pkg))
    const cfg = await loadConfig(TMP, null, false)
    expect(cfg).toEqual({})
  })

  it('ignores a malformed package.json and returns {}', async () => {
    await fsp.writeFile(path.join(TMP, 'package.json'), '{ invalid JSON ')
    // loadConfig should not throw and should return {}
    const cfg = await loadConfig(TMP, null, false)
    expect(cfg).toEqual({})
  })
})

describe('Additional coverage for getIgnoreList (Windows behavior)', () => {
  const TMP = path.join(os.tmpdir(), 'repo2prompt-getIgnoreList')

  beforeEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true })
    await fsp.mkdir(TMP, { recursive: true })
    // Stub os.platform() to 'win32'
    vi.spyOn(os, 'platform').mockReturnValue('win32')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('converts "/" to "\\" on Windows and ignores comments/blank lines', async () => {
    const content = `
# comment
foo/bar.txt

baz/qux/*.js
`
    const ignorePath = path.join(TMP, 'ignore_win.txt')
    await fsp.writeFile(ignorePath, content.trim())
    const patterns = await getIgnoreList(ignorePath, false)
    expect(patterns).toEqual(['foo\\bar.txt', 'baz\\qux\\*.js'])
  })
})

describe('Additional coverage for isBinaryFile', () => {
  const TMP = path.join(os.tmpdir(), 'repo2prompt-isBinaryFile')

  beforeEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true })
    await fsp.mkdir(TMP, { recursive: true })
  })

  it('detects binary by content even without .bin extension', async () => {
    const p = path.join(TMP, 'weird.txt')
    // Insert a null byte in the content
    const buf = Buffer.concat([Buffer.from('ABC'), Buffer.from([0]), Buffer.from('DEF')])
    await fsp.writeFile(p, buf)
    expect(await isBinaryFile(p)).toBe(true)
  })

  it('returns false for a text file without null bytes', async () => {
    const p = path.join(TMP, 'plain.txt')
    await fsp.writeFile(p, 'just text')
    expect(await isBinaryFile(p)).toBe(false)
  })
})

describe('Additional coverage for streamFileWithLimit', () => {
  const TMP = path.join(os.tmpdir(), 'repo2prompt-streamFileWithLimit')

  beforeEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true })
    await fsp.mkdir(TMP, { recursive: true })
  })

  it('logs a debug message when truncation occurs', async () => {
    const p = path.join(TMP, 'big.txt')
    const content = 'A'.repeat(500) + 'B'.repeat(500) // 1000 bytes
    await fsp.writeFile(p, content)
    const out = path.join(TMP, 'out.txt')
    const ws = fs.createWriteStream(out, { encoding: 'utf-8' })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // maxSize = 800, debugMode = true
    await streamFileWithLimit(p, ws, 800, true)
    ws.end()
    await new Promise<void>((resolve) => ws.on('finish', resolve))

    expect(logSpy).toHaveBeenCalledWith(`[DEBUG] File truncated after 800 bytes at "${p}".`)
    logSpy.mockRestore()
  })
})

describe('Additional coverage for writeFilesWithIndex', () => {
  const TMP = path.join(os.tmpdir(), 'repo2prompt-writeFilesWithIndex')
  let fakeBar: Partial<SingleBar>

  beforeEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true })
    await fsp.mkdir(TMP, { recursive: true })
    // Prepare a fake SingleBar
    fakeBar = {
      increment: vi.fn(),
      stop: vi.fn(),
    }
  })

  it('calls increment and stop when a progress bar is provided (stubbing I/O)', async () => {
    // 1) Create two real files for valid paths
    const f1 = path.join(TMP, 'f1.txt')
    const f2 = path.join(TMP, 'f2.txt')
    await fsp.writeFile(f1, 'foo')
    await fsp.writeFile(f2, 'bar')
    const files = ['f1.txt', 'f2.txt']
    const outPath = path.join(TMP, 'output.txt')
    const ws = fs.createWriteStream(outPath, { encoding: 'utf-8' })

    // 2) Stub isBinaryFile to always return false
    vi.spyOn(indexModule, 'isBinaryFile').mockResolvedValue(false)
    // 3) Stub streamFileWithLimit to resolve immediately
    vi.spyOn(indexModule, 'streamFileWithLimit').mockResolvedValue(undefined as any)

    // 4) Call writeFilesWithIndex with fakeBar
    await writeFilesWithIndex(TMP, files, ws, 100, false, fakeBar as SingleBar)
    ws.end()

    // 5) Verify bar.increment() was called twice, then bar.stop() once
    expect(fakeBar.increment).toHaveBeenCalledTimes(2)
    expect(fakeBar.stop).toHaveBeenCalledOnce()

    // 6) Restore stubs
    vi.restoreAllMocks()
  })
})
