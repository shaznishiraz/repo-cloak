/**
 * Git Module Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isGitRepo, getChangedFiles } from '../src/core/git.js';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

describe('Git Module', () => {
    let testDir;

    function initGitRepo(dir) {
        execSync('git init', { cwd: dir });
        execSync('git config user.name "Test User"', { cwd: dir });
        execSync('git config user.email "test@example.com"', { cwd: dir });
    }

    beforeEach(() => {
        testDir = join(tmpdir(), `repo-cloak-git-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testDir)) {
            try {
                rmSync(testDir, { recursive: true, force: true });
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    });

    describe('isGitRepo', () => {
        it('should return true for git repository', () => {
            initGitRepo(testDir);
            expect(isGitRepo(testDir)).toBe(true);
        });

        it('should return false for non-git directory', () => {
            expect(isGitRepo(testDir)).toBe(false);
        });
    });

    describe('getChangedFiles', () => {
        it('should return empty list for clean repo', async () => {
            initGitRepo(testDir);
            const files = await getChangedFiles(testDir);
            expect(files).toEqual([]);
        });

        it('should detect untracked files', async () => {
            initGitRepo(testDir);
            writeFileSync(join(testDir, 'newfile.txt'), 'content');

            const files = await getChangedFiles(testDir);
            expect(files).toContain('newfile.txt');
        });

        it('should detect modified files', async () => {
            initGitRepo(testDir);
            writeFileSync(join(testDir, 'test.txt'), 'initial');
            execSync('git add test.txt', { cwd: testDir });
            execSync('git commit -m "initial"', { cwd: testDir });

            writeFileSync(join(testDir, 'test.txt'), 'changed');

            const files = await getChangedFiles(testDir);
            expect(files).toContain('test.txt');
        });

        it('should expand untracked directories', async () => {
            initGitRepo(testDir);
            const deployDir = join(testDir, 'deploy');
            mkdirSync(deployDir);
            writeFileSync(join(deployDir, 'config.yml'), 'config');
            writeFileSync(join(deployDir, 'script.sh'), 'script');

            // git status --porcelain shows "?? deploy/"
            // We want ["deploy/config.yml", "deploy/script.sh"]

            const files = await getChangedFiles(testDir);
            expect(files).toContain('deploy/config.yml'); // Using forward slash for cross-platform expectation in test
            expect(files).toContain('deploy/script.sh');
            expect(files).toHaveLength(2);
        });

        it('should handle renamed files', async () => {
            initGitRepo(testDir);
            writeFileSync(join(testDir, 'old.txt'), 'content');
            execSync('git add old.txt', { cwd: testDir });
            execSync('git commit -m "initial"', { cwd: testDir });

            execSync('git mv old.txt new.txt', { cwd: testDir });

            const files = await getChangedFiles(testDir);
            expect(files).toContain('new.txt');
            expect(files).not.toContain('old.txt');
        });
    });
});
