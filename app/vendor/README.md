# Vendored: the sniper-tax TypeScript SDK

`majocoreborn-sniper-tax-sdk-<version>.tgz` is the npm package of `@majocoreborn/sniper-tax-sdk`,
built from `sdk/` in
[MajocoReborn/pipeline-sniper-tax-strate](https://github.com/MajocoReborn/pipeline-sniper-tax-strate)
at the commit pinned in `scripts/update-sdk.sh` (`SDK_COMMIT`). `package.json` installs it
from here until the SDK is on npm.

- `scripts/update-sdk.sh` rebuilds it at the pinned commit (`npm pack` is reproducible) and
  copies that commit's test vectors to `test/vectors.json`.
- `scripts/update-sdk.sh --check`, run by CI, fails unless both files are exactly what that
  commit gives.

Once the SDK is on npm: depend on `"@majocoreborn/sniper-tax-sdk": "<version>"`, delete this
folder and the `--check` step, and keep `test/vectors.json` in step with the installed
version (it is in that repository's `sdk/test/`).
