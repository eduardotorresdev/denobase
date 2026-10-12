# S3 storage: manual test script

Validates record files, thumbs, backups and files migration against a real S3 bucket (AWS, R2, B2...) or MinIO.
Automated tests use a fake S3; this script covers what only a real server shows (signing, Range, path style, listing).
Each step lists the expected result; "bucket" means what you see in the S3 console or with `mc ls -r`.

## 0. Setup

MinIO locally (skip if you use a real bucket):

```sh
docker run -d --name minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio12345 minio/minio server /data --console-address :9001
mc alias set local http://localhost:9000 minio minio12345
mc mb local/files local/backups
```

Values used below: endpoint `http://localhost:9000`, region `us-east-1`, access key `minio`, secret `minio12345`, force
path style on (required by MinIO; off for AWS virtual-host buckets).

Start a fresh app (`serve --db ./pb_data/data.db`), create a superuser, and a collection `docs` with a file field
`attachment` (max 3 files, thumbs `100x100`, `0x50`) and one with `protected` on. Upload 3-5 records with files (include
a PNG, a JPEG and a file > 5 MB) **while still on local storage**: they are the migration input in step 5.

## 1. Settings and test connection

1. Settings > S3 (files): fill endpoint, bucket `files`, region, keys, force path style. Leave "Use S3" **off** for now
   and save. Click "Test connection".
   - Expected: error "S3 storage filesystem is not enabled" (the test uses the saved config, enabled only).
2. Backups settings: enable S3 with bucket `backups`, save, test (`POST /api/settings/test/s3`
   `{"filesystem":"backups"}`).
   - Expected: 204 / success toast. Bucket: nothing left behind (the probe object is written then deleted).
3. Break it: wrong secret, save, test.
   - Expected: 400 "Failed to test the S3 filesystem. Raw error: ..." with the S3 error (SignatureDoesNotMatch /
     InvalidAccessKeyId). Restore the right secret.
4. `GET /api/settings` as superuser.
   - Expected: `s3.secret` and `backups.s3.secret` are never returned.

## 2. Switch local -> S3 in the UI (migration dialog)

1. Settings > S3: turn "Use S3 storage for record files" on, save.
   - Expected: the dialog opens, "Counting files in the previous storage...", then "Migrate N files (X MB) from local
     storage to S3 files@http://localhost:9000?" with the 404 warning and the "Delete the files from the previous
     storage" checkbox (unchecked). N counts originals **and** thumbs already generated.
2. Click "Not now". Open a record's file URL from step 0.
   - Expected: 404 (files are read only from the new storage). The S3 tab shows a "proposed" job.
3. Start it from the S3 tab (or reopen and click "Migrate files"), delete source unchecked.
   - Expected: progress bar, "x of N files · c copied · s already there · bytes", status "done".
   - Bucket `files`: `<collectionId>/<recordId>/<filename>` for each file, `.../thumbs_<filename>/<size>_<filename>` for
     thumbs; no `.attrs`, no `pb_settings_test/` or probe keys. `pb_data/storage` still has everything.
4. Old file URLs now return 200 with the same bytes (`sha256sum` local copy vs download) and the same Content-Type.

## 3. Upload, download, Range, protected

With S3 on:

1. Create a record with a new file via the UI and via `curl -F attachment=@big.bin`.
   - Expected: 200; bucket has the object with the right Content-Type; nothing new under `pb_data/storage`.
2. `curl -sD- .../api/files/docs/<id>/<file>`: 200, Content-Length, Content-Type, `Content-Disposition`; download query
   `?download=1` sets `attachment`.
3. Range: `curl -sD- -H 'Range: bytes=0-99' URL` -> 206, `Content-Range: bytes 0-99/<size>`, 100 bytes.
   `-H 'Range: bytes=-10'` -> last 10 bytes. `bytes=<size>-` -> 416.
   - Video/audio seek in the browser works.
4. Protected field: without token 404; with `?token=` from `POST /api/files/token` 200.
5. Replace and delete a file on the record, then delete the record.
   - Expected: the bucket loses the old object and its `thumbs_<filename>/` prefix; after record delete nothing under
     `<collectionId>/<recordId>/`.
6. Failed save: send an invalid field with a file.
   - Expected: 400, and no orphan object in the bucket.

## 4. Thumbs

1. `URL?thumb=100x100` on a PNG and a JPEG.
   - Expected: 200 image of that size; bucket gains `thumbs_<filename>/100x100_<filename>`. Second request is served
     from the bucket (no new object, faster).
2. `?thumb=0x50`: height 50, aspect kept. `?thumb=33x33` (not declared): the original is returned, no new object.
3. Non-image file with `?thumb=100x100`: the original, no thumb object.

## 5. Backups on S3

1. Backups page: "Create backup" (name it `manual.zip`).
   - Expected: listed with size and date; bucket `backups` has `manual.zip` at the top level; nothing in
     `pb_data/backups`. Creating `manual.zip` again: 400 (never overwritten).
2. Download it (UI or `GET /api/backups/manual.zip?token=<file token>`): valid zip with `data.db` (and the aux db as in
   PB). Range works as in step 3.
3. Change data (delete a record), then Restore `manual.zip`.
   - Expected: the app restarts, the deleted record is back. Record files stay on S3 (backups do not include S3 files,
     like PB): the restored record's file URL still works.
4. Upload a zip (`POST /api/backups/upload`), delete a backup: the bucket mirrors both.
5. Auto backups (cron + max keep 2): after 3 runs, only the 2 newest `@auto_pb_backup_*.zip` remain in the bucket.

## 6. CLI `storage migrate`

Stop the server first (or run against a running one: the CLI follows/joins the active job, see 6.5).

1. Intent check: with S3 on in settings, `storage migrate --from s3 --to local`.
   - Expected: exit 1, "--to local is not the current files storage (s3). Save the new storage in the settings first".
     Bad values (`--from ftp`) exit 2 with usage.
2. S3 -> local: turn S3 off in settings, save (dialog: "Not now"). The old bucket is no longer in settings, so pass it:

   ```sh
   export DENOBASE_FROM_S3_BUCKET=files DENOBASE_FROM_S3_REGION=us-east-1 \
     DENOBASE_FROM_S3_ENDPOINT=http://localhost:9000 DENOBASE_FROM_S3_ACCESS_KEY=minio \
     DENOBASE_FROM_S3_SECRET=minio12345 DENOBASE_FROM_S3_FORCE_PATH_STYLE=1
   storage migrate --from s3 --to local --dry-run --db ./pb_data/data.db
   ```

   - Expected: "dry run: T file(s) at the source, C to copy (B bytes), S already there"; nothing written anywhere
     (`find pb_data/storage -newer <marker>` empty). Flags `--from-s3-bucket` etc. override the env.
   - Missing one: exit 2, "--from s3 needs secret (--from-s3-* flags or DENOBASE_FROM_S3_* env)".
3. Run it without `--dry-run`.
   - Expected: `[running] i/T (...)` lines, then `[done] T/T (copied C, skipped S, failed 0, ...)`, exit 0. Every file
     under `pb_data/storage`, served by the app; bucket unchanged. Run again: all skipped, exit 0.
4. `--delete-source`: turn S3 on again, `storage migrate --from local --to s3 --delete-source`.
   - Expected: done, failed 0; then `pb_data/storage` has no record files left; bucket has all of them. If any key
     failed, nothing is deleted from the source.
5. `--dry-run` or a different `--from`/`--delete-source` while a job runs (start one in the UI): exit 1, "a files
   migration is already running ...". The same command follows it ("following it") and exits with its result.

## 7. Resume after kill

1. Put enough data at the source to take a while (e.g. 2,000 small files, or throttle MinIO), start
   `storage migrate --from local --to s3`, and `kill -9` it halfway (note the last `i/T`).
2. Open Settings > S3 in the UI.
   - Expected: after the lease expires (a few seconds) the job reads "stalled" with a Resume button.
3. Either click Resume, or rerun the same CLI command (it takes the job over: no "already running" error).
   - Expected: continues after the last handled key (counter does not restart at 0, already copied keys count as
     skipped); ends "done", failed 0. Object count in the bucket = T; no duplicates, no partial objects (compare sizes /
     `mc ls -r --summarize`).
4. Same with the server: kill the server mid UI-migration, restart it.
   - Expected: stalled -> Resume completes. Cancel during a run: status "canceled", Resume continues.

## Clean up

Turn S3 off, `docker rm -f minio`, delete test buckets. Rotate any real keys used.
