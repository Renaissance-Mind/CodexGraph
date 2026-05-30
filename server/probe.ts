import { scanAll } from './scanner'

const t0 = Date.now()
const p = scanAll(true)
const elapsed = Date.now() - t0
console.log('scan ms:', elapsed)
console.log('repos:', p.repos.length, 'default:', p.defaultRepoId)
for (const r of p.repos.slice(0, 8)) {
  const b = p.bundles[r.id]
  console.log(
    `  ${r.name.padEnd(28)} ses=${String(r.sessionCount).padStart(3)} wt=${String(r.worktreeIds.length).padStart(2)} br=${String(r.branchIds.length).padStart(2)} co=${String(r.commitCount).padStart(3)} range=${b.dateRange.label}`,
  )
}
const def = p.bundles[p.defaultRepoId]
if (def) {
  console.log('\n=== default repo:', def.repo.name, '===')
  console.log('worktrees:')
  for (const wt of def.worktrees) {
    console.log(`  - ${wt.branchName} [${wt.status}] sessions=${wt.sessionCount} path=${wt.path}`)
  }
  console.log('branches (showing first 12):')
  for (const b of def.branches.slice(0, 12)) {
    console.log(`  - ${b.name} lane=${b.lane} status=${b.status} fork=${b.forkFromCommitId || '-'} merged=${b.mergedIntoCommitId || '-'} default=${b.isDefault}`)
  }
  console.log('first 5 sessions:')
  for (const s of def.sessions.slice(0, 5)) {
    console.log(`  - ${s.label} ${s.date.slice(0,16)} (${s.durationMin}m) [${s.model}] ${s.title.slice(0, 60)}`)
  }
}
