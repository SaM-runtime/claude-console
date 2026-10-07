import { expect, test } from 'claude-code/testing'
import { dangerReason, guardMode, segments } from '../hooks/guard'

test('irreversible commands are named; ordinary ones and build-output cleanup pass', () => {
  const dangerous: [string, RegExp][] = [
    ['rm -rf src', /遞迴刪除 src/],
    ['sudo rm -r -f ~/projects', /遞迴刪除/],
    ['cd app && rm --recursive "$TARGET"', /遞迴刪除/],
    ['git push --force origin main', /強制推送/],
    ['git push -f', /強制推送/],
    ['git -C D:/repo push --mirror', /強制推送/],
    ['git push origin --delete feature', /刪除遠端分支/],
    ['git push origin :old', /刪除遠端分支/],
    ['git reset --hard HEAD~3', /reset --hard/],
    ['git clean -fdx', /未追蹤/],
    ['git checkout -- .', /丟棄工作區/],
    ['git restore .', /丟棄工作區/],
    ['git branch -D topic', /強制刪除分支/],
    ['git stash clear', /stash/],
    ['git filter-repo --path secrets', /改寫/],
    ['psql -c "DROP TABLE users"', /資料表/],
    ['echo x | mysql -e "truncate table logs"', /資料表/],
    ['Remove-Item -Recurse -Force C:\\work', /遞迴刪除/],
    ['rd /s /q build2', /遞迴刪除/],
    ['dd if=img of=/dev/sda', /磁碟/],
    ['terraform destroy -auto-approve', /terraform/],
    ['kubectl delete ns staging', /Kubernetes/],
    ['npm publish --access public', /發布套件/],
    ['gh release create v1.0.0', /release/],
    ['gh repo delete me/x --yes', /刪除 GitHub repo/],
  ]
  for (const [command, reason] of dangerous) expect([command, dangerReason(command)]).toEqual([command, expect.stringMatching(reason)])
  const ordinary = [
    'rm -rf node_modules dist .next', 'rm -rf ./build packages/app/coverage', 'rm file.txt', 'rm -f a b',
    'git push', 'git push -u origin feature', 'git push --force-with-lease', 'git reset HEAD~1', 'git reset --soft HEAD~1',
    'git clean -n', 'git checkout main', 'git checkout -- src/a.ts', 'git restore --staged .', 'git branch -d merged',
    'git stash pop', 'npm test', 'npm run build 2>&1 | tail', 'echo "rm -rf /" > notes.txt',
    'Remove-Item -Recurse node_modules', 'kubectl delete pod web-1', 'docker system prune', 'gh pr view --web',
  ]
  for (const command of ordinary) expect([command, dangerReason(command)]).toEqual([command, null])
})

test('segments keep quoted separators together', () => {
  expect(segments('a && b; c | d\ne')).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(segments('echo "x; rm -rf /" && ls')).toEqual(['echo "x; rm -rf /"', 'ls'])
})

test('commandGuard option: ask by default, deny or off on request', () => {
  expect(guardMode(undefined)).toBe('ask')
  expect(guardMode('DENY')).toBe('deny')
  expect(guardMode('off')).toBe('off')
  expect(guardMode('nonsense')).toBe('ask')
})
