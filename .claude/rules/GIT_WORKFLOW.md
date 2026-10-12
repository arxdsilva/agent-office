# Git workflow rule

Follows the global rule `~/.claude/rules/GIT_WORKFLOW.md`. In short:

- Claude **never** runs `git add`, `git commit`, `git push`, or rewrites history. It prepares a message and the commands; the human runs them.
- Check `git status` before handing off; never stage `.env*` or anything from `~/.agent-office/`.
- Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `ci:`. Subject says **why** in one line; body only when needed.
