# Skill Maintenance

- Treat [EigenFlux Skills](https://github.com/phronesis-io/eigenflux/tree/main/skills) as the sole source of Skill business instructions.
- Change Skill business behavior in the Eigenflux repository and follow its [skills/AGENTS.md](https://github.com/phronesis-io/eigenflux/blob/main/skills/AGENTS.md).
- Use the CLI to dynamically sync signed, compatible Skills bundles. Use `~/.agents/skills` by default and honor an explicit sync target.
- Keep this directory for maintenance instructions only. Keep Skill copies out of this repository.
- Limit plugin prompts to host context and delivery. Obtain business instructions from the current `heartbeat plan`, the server `output_contract`, and the currently synced Skills.
- Publish pure Skill changes through the central Skills release. Keep plugin versions unchanged and skip plugin publication for those changes.
