// PreToolUse hook entry point (#317): always runs, always exits 0 (allow) or
// 2 (deny). The hook command also appends `|| exit 2`, so a failure to even
// start this script denies the navigation instead of allowing it.
import { runHook } from '../src/nav-hook'

runHook(process.stdin, process.env, process.stderr)
  .then((code) => process.exit(code))
  .catch(() => process.exit(2))
