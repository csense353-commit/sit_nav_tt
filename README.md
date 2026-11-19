[README-NETLIFY.md](https://github.com/user-attachments/files/35099365/README-NETLIFY.md)
# SIT Campus Navigator — Netlify Blobs setup

This version replaces the placeholder Firebase/Firestore integration with a Netlify
Serverless Function backed by a **site-wide Netlify Blobs store**. Timetable data
for sections G and H is shared by every visitor and survives new deployments.
Students can read; only authenticated teacher sessions can publish.

## Deploy

1. Put `index.html`, `netlify.toml`, `package.json`, and the `netlify/` folder at
   the root of your Git repository.
2. Import the repository into Netlify (or connect your existing Netlify site).
3. Netlify installs the dependencies from `package.json` and deploys the function.
4. In Netlify: **Project configuration → Environment variables**, add:
   - `TEACHER_TOKEN_SECRET`: a long random secret (at least 32 characters).
   - `TEACHER_ACCOUNTS`: JSON object containing teacher accounts. Example:

```json
{
  "teacher1": {
    "password": "replace-with-a-strong-unique-password",
    "name": "Teacher 1",
    "subjects": ["AMS1", "ETC13", "CC09"]
  },
  "teacher2": {
    "password": "replace-with-a-strong-unique-password",
    "name": "Teacher 2",
    "subjects": ["APS", "APS LAB", "AMS1 LAB"]
  },
  "teacher3": {
    "password": "replace-with-a-strong-unique-password",
    "name": "Teacher 3",
    "subjects": ["PSC5", "PSCL5", "ESCO7", "SDCIS1", "CC03/CC04"]
  },
  "admin": {
    "password": "replace-with-a-strong-unique-password",
    "name": "Class Coordinator",
    "subjects": ["*"]
  }
}
```

5. Trigger a new deploy after setting the environment variables.

Use unique strong passwords; the example values are placeholders, not valid credentials.
Do not put these environment variables, passwords, or the token secret in `index.html`
or commit them to Git. The browser receives a signed, time-limited teacher token after
successful sign-in. Tokens expire after 8 hours and are kept in session storage.

## How syncing works

- The function exposes public read access for the two student timetables.
- Teacher sign-in and publishing are handled server-side.
- Timetables are stored as two JSON blobs (`section-G` and `section-H`) in the
  `sit-campus-timetables` site-wide store.
- The browser checks for updates every 15 seconds and also keeps a local offline copy.
- The Blobs store is site-wide, so data persists across deployments. Netlify Blobs
  has propagation/consistency characteristics; this app requests strong consistency
  for reads. This is a simple key/value persistence layer, not a transactional database.
- Do not use this shared production data store for destructive tests from deploy previews.

## Local development

```bash
npm install
npx netlify dev
```

Set `TEACHER_TOKEN_SECRET` and `TEACHER_ACCOUNTS` in a local `.env` file (never commit it).
Open the local Netlify dev URL, not by double-clicking `index.html`, because the
serverless endpoint must be running.

## Important

This implements shared persistence and server-side teacher authentication. It does
not add individual student accounts or private per-student data: timetable reads are
public by design. Netlify Blobs is suitable for this small shared timetable. If you
later need many simultaneous editors, strict conflict-free concurrent updates,
per-user records, or relational queries, use a database with transactions instead.
