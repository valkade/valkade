import { describe, expect, it } from 'vitest';
import { classifyShellCommand } from './shell-command-intent';

describe('classifyShellCommand', () => {
  it('detects PowerShell and POSIX file read commands', () => {
    expect(classifyShellCommand('Get-Content src/app.ts')).toBe('read');
    expect(classifyShellCommand('Get-Content -Path src/app.ts -TotalCount 40')).toBe('read');
    expect(classifyShellCommand('gc src/app.ts | Select-Object -Skip 10 -First 30')).toBe('read');
    expect(classifyShellCommand('[System.IO.File]::ReadAllText("src/app.ts")')).toBe('read');
    expect(classifyShellCommand('[IO.File]::ReadAllLines("src/app.ts")')).toBe('read');
    expect(classifyShellCommand('cat package.json')).toBe('read');
    expect(classifyShellCommand('type package.json')).toBe('read');
    expect(classifyShellCommand('head -n 25 src/main.ts')).toBe('read');
    expect(classifyShellCommand('tail -n 50 logs/app.log')).toBe('read');
    expect(classifyShellCommand("sed -n '1,40p' src/main.ts")).toBe('read');
    expect(classifyShellCommand('cd src; Get-Content app.ts 2>$null')).toBe('read');
  });

  it('detects search and directory listing commands', () => {
    expect(classifyShellCommand('Select-String -Path src/*.ts -Pattern "toolGlyph"')).toBe('search');
    expect(classifyShellCommand('sls "foo" src/app.ts')).toBe('search');
    expect(classifyShellCommand('Get-ChildItem -Recurse src | Select-String "toolGlyph"')).toBe('search');
    expect(classifyShellCommand('rg "toolGlyph" src/')).toBe('search');
    expect(classifyShellCommand('git grep -n "toolGlyph" src/')).toBe('search');
    expect(classifyShellCommand('grep -rn "foo" src/')).toBe('search');
    expect(classifyShellCommand('findstr /s /i "foo" src\\*.ts')).toBe('search');

    expect(classifyShellCommand('Get-ChildItem src -Recurse -Name')).toBe('list');
    expect(classifyShellCommand('gci -Force')).toBe('list');
    expect(classifyShellCommand('ls -la src/')).toBe('list');
    expect(classifyShellCommand('dir src')).toBe('list');
    expect(classifyShellCommand('tree /F')).toBe('list');
    expect(classifyShellCommand('rg --files src/')).toBe('list');
    expect(classifyShellCommand('git ls-files src/')).toBe('list');
  });

  it('detects PowerShell and POSIX file edit commands (taking priority over reads)', () => {
    expect(
      classifyShellCommand("(Get-Content src/app.ts -Raw) -replace 'old', 'new' | Set-Content src/app.ts"),
    ).toBe('edit');
    expect(
      classifyShellCommand(
        "$c = Get-Content -Raw src/app.ts; $c = $c.Replace('old', 'new'); Set-Content src/app.ts $c",
      ),
    ).toBe('edit');
    expect(
      classifyShellCommand(
        "$t = [System.IO.File]::ReadAllText('a.ts'); [System.IO.File]::WriteAllText('a.ts', $t.Replace('a','b'))",
      ),
    ).toBe('edit');
    expect(classifyShellCommand("$c = Get-Content a.ts; $c[2] = 'x'; Set-Content a.ts $c")).toBe('edit');
    expect(classifyShellCommand("sed -i 's/foo/bar/g' src/app.ts")).toBe('edit');
    expect(classifyShellCommand("perl -pi -e 's/foo/bar/g' src/app.ts")).toBe('edit');
    expect(classifyShellCommand('git apply fix.patch')).toBe('edit');
    expect(classifyShellCommand('Rename-Item src/a.ts src/b.ts')).toBe('edit');
    expect(classifyShellCommand('Move-Item src/a.ts src/b.ts')).toBe('edit');
    expect(classifyShellCommand('mv src/a.ts src/b.ts')).toBe('edit');
    // Truncated PowerShell read-modify-write where Set-Content fell past preview cap
    expect(classifyShellCommand("$c = Get-Content src/app.ts -Raw; $c = $c -replace 'very long…")).toBe('edit');
  });

  it('detects PowerShell and POSIX file write, copy, and delete commands', () => {
    expect(classifyShellCommand('Set-Content -Path src/new.ts -Value "export const x = 1;"')).toBe('write');
    expect(classifyShellCommand('Add-Content src/log.txt "entry"')).toBe('write');
    expect(classifyShellCommand('Out-File -FilePath src/out.txt -InputObject $data')).toBe('write');
    expect(classifyShellCommand('New-Item -ItemType File -Force src/new.ts')).toBe('write');
    expect(classifyShellCommand('[IO.File]::WriteAllText("src/new.ts", $text)')).toBe('write');
    expect(classifyShellCommand('echo "hello" > src/new.txt')).toBe('write');
    expect(classifyShellCommand("cat << 'EOF' > src/new.ts\nexport const x = 1;\nEOF")).toBe('write');
    expect(classifyShellCommand('touch src/new.ts')).toBe('write');
    expect(classifyShellCommand('mkdir src/newdir')).toBe('write');
    expect(classifyShellCommand("$content = @'\nimport { Component } from '@angular/core';…")).toBe('write');

    expect(classifyShellCommand('Copy-Item a.ts b.ts')).toBe('copy');
    expect(classifyShellCommand('cp a.ts b.ts')).toBe('copy');
    expect(classifyShellCommand('Remove-Item -Force tmp.txt')).toBe('delete');
    expect(classifyShellCommand('rm -rf dist')).toBe('delete');
    expect(classifyShellCommand('del tmp.txt')).toBe('delete');
  });

  it('detects inline python -c and node -e file reads and edits', () => {
    expect(
      classifyShellCommand(
        'python -c "from pathlib import Path; p=Path(\'a.ts\'); p.write_text(p.read_text().replace(\'a\',\'b\'))"',
      ),
    ).toBe('edit');
    expect(classifyShellCommand('python -c "from pathlib import Path; Path(\'a.ts\').write_text(\'hi\')"')).toBe(
      'write',
    );
    expect(classifyShellCommand('python3 -c "print(open(\'a.ts\').read())"')).toBe('read');
    expect(classifyShellCommand('python -c "import os; print(os.listdir(\'src\'))"')).toBe('list');
    expect(classifyShellCommand('python -c "import os; os.remove(\'tmp.txt\')"')).toBe('delete');

    expect(
      classifyShellCommand(
        'node -e "const fs=require(\'fs\'); fs.writeFileSync(\'a.ts\', fs.readFileSync(\'a.ts\',\'utf8\').replace(\'a\',\'b\'))"',
      ),
    ).toBe('edit');
    expect(classifyShellCommand('node -e "require(\'fs\').writeFileSync(\'a.ts\', \'hi\')"')).toBe('write');
    expect(classifyShellCommand('node -e "console.log(require(\'fs\').readFileSync(\'a.ts\', \'utf8\'))"')).toBe(
      'read',
    );
  });

  it('unwraps nested pwsh/powershell/bash/cmd wrappers', () => {
    expect(classifyShellCommand('pwsh -NoProfile -Command "Get-Content src/app.ts"')).toBe('read');
    expect(
      classifyShellCommand(
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Content a.txt \'hello\'"',
      ),
    ).toBe('write');
    expect(classifyShellCommand('bash -c "rg foo src/"')).toBe('search');
    expect(classifyShellCommand('cmd /c "dir src"')).toBe('list');
  });

  it('keeps build, test, git, and filtered stdout pipelines as run', () => {
    expect(classifyShellCommand('npm test')).toBe('run');
    expect(classifyShellCommand('npm test 2>&1 | Select-Object -Last 30')).toBe('run');
    expect(classifyShellCommand('pytest | Select-String "FAILED"')).toBe('run');
    expect(classifyShellCommand('npx tsc --noEmit | head -n 40')).toBe('run');
    expect(classifyShellCommand('python -m pytest -k test_write_file')).toBe('run');
    expect(classifyShellCommand('git status')).toBe('run');
    expect(classifyShellCommand('git diff --stat')).toBe('run');
    expect(classifyShellCommand('git commit -m "Update > arrow"')).toBe('run');
    expect(classifyShellCommand('echo "a > b"')).toBe('run');
    expect(classifyShellCommand('npm run build >$null 2>&1')).toBe('run');
    expect(classifyShellCommand('sc query Spooler')).toBe('run');
    expect(classifyShellCommand('sc.exe stop MyService')).toBe('run');
    expect(classifyShellCommand('')).toBe('run');
  });
});
