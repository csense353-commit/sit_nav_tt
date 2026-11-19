# SIT Campus Navigator — Netlify Blobs event storage

This project uses **Netlify Blobs only for timetable data and timetable changes**.
It does not store teacher usernames, passwords, sessions, or login tokens in Blobs.
Teacher authentication remains separate and uses Netlify environment variables plus
short-lived signed tokens.

## What changed

- Each published timetable change is saved as its own immutable Blob event.
- Changes are stored under `section-G/events/` or `section-H/events/` in the
  `sit-campus-timetable-events` site-wide store.
- A weekly timetable replacement is saved as a separate base-version event.
- Cancellations, time/subject edits, swaps, and extra classes are saved as
  individual upsert/delete events rather than rewriting one shared timetable file.
- On reads, the server combines the base timetable with the latest event for each
  logical timetable slot.
- Independent changes made by different teachers do not overwrite each other.
- The browser polls the shared timetable every 5 seconds and keeps local storage
  only as an offline/browser backup.
- The store is site-wide and persists across normal site deployments.

## Concurrency behaviour and limitation

This append-only event-log design avoids the usual lost-update problem where two
teachers read one JSON timetable, make different changes, and the later whole-file
save erases the earlier teacher's work. Each event has a unique key and is created
with `onlyIfNew`, so independent writes do not compete for the same Blob key.

If two teachers change the **same logical class slot** at nearly the same time,
Blobs cannot provide a transaction or a global lock. Both events are retained;
the server deterministically chooses the event with the later server timestamp
(and event id as a tie-breaker) for display. This is a last-update-wins rule for
that one slot. If you need strict conflict rejection/merging for edits to the exact
same slot, use a transactional database such as Netlify DB rather than Blobs.

The event log is append-only and is read/rebuilt when a section is requested. For
this small campus timetable it is straightforward; if the number of changes grows
very large, add a safe compaction/archive process or move the data to a database.

## Deploy to Netlify

1. Extract the ZIP file.
2. Put `index.html`, `netlify.toml`, `package.json`, and the `netlify/` folder at
   the root of your Git repository.
3. Import/connect that repository in Netlify. The site publish directory is `.`
   and the Functions directory is `netlify/functions` (already configured).
4. In Netlify, open **Project configuration → Environment variables** and add:
   - `TEACHER_TOKEN_SECRET`: a long random secret (at least 32 characters).
   - `TEACHER_ACCOUNTS`: JSON containing teacher accounts. Example:

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
6. Open the deployed Netlify URL (not the local HTML file) and test a published
   change from a teacher session, then verify it in a separate browser/student view.

The sample passwords above are placeholders. Use unique strong passwords. Do not
put passwords or `TEACHER_TOKEN_SECRET` in `index.html` or commit them to Git.
These credentials are not written to the Blobs store.

## Local development

```bash
npm install
npx netlify dev
```

Set `TEACHER_TOKEN_SECRET` and `TEACHER_ACCOUNTS` in a local `.env` file (never
commit it). Open the local Netlify Dev URL, not `index.html` directly.

## Netlify Blobs data layout

```text
Store: sit-campus-timetable-events
  section-G/events/<unique-event-id>
  section-H/events/<unique-event-id>
```

Event kinds are `base-set`, `alt-upsert`, and `alt-delete`. No login records or
credentials are saved in this store.

## Notes

- Student timetable reads are public by design.
- Teacher writes still require a valid teacher session; this is separate from
  timetable persistence.
- The old whole-record store (`sit-campus-timetables`) is not automatically
  migrated by this version. If you already published timetable data using the
  earlier ZIP, export it from the old app before switching versions and import
  the JSON using the app's timetable import control after deploying this one.
