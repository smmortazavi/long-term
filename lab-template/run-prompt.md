Run {{run_id}}: test the scenario "{{scenario_title}}" against {{target_name}} ({{base_url}}) as the role "{{role}}".

1. Read `CLAUDE.md` if you have not, then `LEARNINGS.md`.
2. Read the scenario at `{{scenario_path}}/scenario.md`.
3. Credentials for this role are in the environment: `TARGET_{{role_upper}}_USERNAME` and
   `TARGET_{{role_upper}}_PASSWORD`. Use them only through `lib/login.mjs`; never print them.
4. Follow the steps in order, taking one screenshot per step into `{{run_dir}}/screenshots/`.
5. Write `{{run_dir}}/report.md` as described in `CLAUDE.md`, verdict on the first line.
6. Print `RUN DONE: <VERDICT>` and stop.
