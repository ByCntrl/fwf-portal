# Fight Wright Foundation Volunteer Portal

Public portal:   portal.fightwrightfoundation.org
Team profiles:   portal.fightwrightfoundation.org/team   (send this link to FWF admins)
Admin:           the "Fight Wright Foundation Portal" base in Airtable

## Managing the portal (no code)
Everything on the portal comes from Airtable and updates within about a minute:
- Portal Settings: Donorbox link, shop link, waiver text, photo release text, waiver version.
  When the waiver language changes, also change Waiver Version so signatures stay traceable.
- Shifts: add, edit, or delete. Past shifts hide automatically.
- Teams: add a team and check Active to show it at registration.
- Sponsors: name, tier, logo upload, website. Check Show on Walk Day to display.
- Announcements: newest five with Audience "Everyone" (or blank) appear on Home.
- Impact Levels: amounts and what they fund, shown on the Give tab.
- Admin Team: profiles submitted at /team. Check Show on Portal to approve.

Submissions land in: Volunteers, Waivers, Shift Signups, Hours Log, Survivor Stories,
Community Posts (Why I Fight, cheers).

## Deploy (functions included)
Drag-and-drop does NOT deploy the Airtable function. Use one of these, inside this folder:
  a. Netlify CLI:  npm i -g netlify-cli ; netlify login ; netlify deploy --prod
  b. GitHub: push this folder to a repo, then Netlify > Add new site > Import from Git.

## Environment variables (Netlify > Site configuration > Environment variables)
  AIRTABLE_TOKEN = Airtable personal access token with scopes data.records:read and
                   data.records:write, access limited to "Fight Wright Foundation Portal"
  ALLOWED_ORIGIN = https://portal.fightwrightfoundation.org
Redeploy after adding them.

## Custom domain
1. Netlify: Domain management > Add a domain > portal.fightwrightfoundation.org
2. In whichever account manages DNS for fightwrightfoundation.org (GoDaddy or Hostinger):
   add record Type CNAME, Name portal, Value <your-site>.netlify.app. Change nothing else.
3. Netlify: Verify. HTTPS turns on automatically.

## Launch checklist
- Replace the placeholder shifts and the DRAFT waiver text in Airtable.
- Delete the sample records (Volunteers, Hours Log, Donations).
- Submit one test registration, shift signup, hours entry, and /team profile; confirm in Airtable.
