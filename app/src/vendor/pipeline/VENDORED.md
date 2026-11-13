# Vendored: one file of Pipeline's TypeScript SDK

The site uses Pipeline's SDK from npm (`@pipeline-sol/sdk`), except for `http.ts`
(`boundedFetch`, a fetch with size and time limits), which the package doesn't export.
`http.ts` is a copy of `sdk/ts/src/http.ts` from
[MetalLegBob/pipeline](https://github.com/MetalLegBob/pipeline) at commit
`ca6c37d` (release 0.1.1, the version in `package.json`), licensed under the Apache License
2.0 (`LICENSE-APACHE` in that repository). It is unmodified.
