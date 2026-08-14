# Publishing an immutable reconstruction manifest

The repository source is public, but a specific Notons catalogue generation is
only documented once its metadata-only manifest is published from the exact Git
revision that produced it.

1. Work from a clean, reviewed commit on `main`.
2. Reconstruct the verified official archive using the full command recorded by
   the method document and write its metadata-only result with
   `--result dist/reconstruction-result.json`.
3. Generate the manifest with
   `npm run catalog:off-manifest -- ... --result dist/reconstruction-result.json --output dist/reconstruction-manifest.json`.
   The ignored `dist/` directory is deliberate: release artefacts remain outside
   the normative Git worktree, whose cleanliness is still checked by every
   attested command. Each normative file is also compared byte-for-byte with its
   `HEAD` blob, independently of Git index flags such as `assume-unchanged` or
   `skip-worktree`.
4. Run:

   ```text
   npm run manifest:verify -- dist/reconstruction-manifest.json \
     --archive <official-archive> \
     --revision <40-character-commit>
   ```

5. Publish only the JSON manifest and its SHA-256 checksum. Never attach the
   source archive, a dump, a reconstruction result, logs or environment files.
6. Use a protected immutable tag named
   `off-YYYYMMDD-<first-12-archive-sha256>` and keep the release available for as
   long as the corresponding public product can be used.

Before the first release, enable immutable releases and protect the `off-*` tag
pattern in the GitHub repository settings.
