# Setup guide — Axsys Time Off

About an hour, start to finish. You'll need: a Supabase account, a Resend account
(email), access to the `axsysinc.com` DNS settings, a GitHub account, and a place to
host a static website (Netlify or Cloudflare Pages — both have free tiers).

Install once on your computer: [Node.js 20+](https://nodejs.org) and the
[Supabase CLI](https://supabase.com/docs/guides/cli) (`npm i -g supabase` or `scoop install supabase`).

---

## 1. Create the cloud database

1. Go to <https://supabase.com> → **New project**. Name it `axsys-time-off`, pick the
   **US East** region, set a strong database password, and save it in your password manager.
   *For a business app use a paid plan: free projects pause when idle.*
2. In a terminal, from this folder:
   ```bash
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF      # the ref is in the project URL
   supabase db push                                   # creates all tables + security rules
   ```
   (No CLI? Open **SQL Editor**, paste all of `supabase/migrations/20261012000000_init.sql`, click **Run**.)

3. **Turn off public sign-up — important.** Authentication → Sign In / Providers →
   turn **off** “Allow new users to sign up”. Accounts are created only by managers from the portal.

## 2. Set up email (Resend)

1. Sign up at <https://resend.com>.
2. **Domains → Add domain** → `axsysinc.com`. Add the DNS records it shows (SPF/DKIM)
   at your DNS provider and wait until it shows **Verified**. Until the domain is
   verified, Resend will only deliver to your own address.
3. **API Keys → Create** (sending access). Copy the key.

## 3. Deploy the server functions

Generate a random secret (any 40+ character random string works):
```bash
openssl rand -hex 32        # or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Then:
```bash
supabase secrets set \
  NOTIFY_SECRET=PASTE-THE-RANDOM-SECRET \
  RESEND_API_KEY=re_xxxxxxxx \
  "EMAIL_FROM=Axsys Time Off <timeoff@axsysinc.com>" \
  MANAGER_EMAIL=ryant@axsysinc.com \
  PORTAL_URL=https://timeoff.axsysinc.com

supabase functions deploy notify
supabase functions deploy admin-users
```
`MANAGER_EMAIL` accepts several addresses separated by commas.
Set `PORTAL_URL` to wherever you host the portal in step 5 (you can update it later
with `supabase secrets set PORTAL_URL=...`).

Now tell the database where to send email events. In **SQL Editor** run (same secret as above):
```sql
insert into private.settings (key, value) values
  ('notify_url',    'https://YOUR-PROJECT-REF.supabase.co/functions/v1/notify'),
  ('notify_secret', 'PASTE-THE-RANDOM-SECRET')
on conflict (key) do update set value = excluded.value;
```

## 4. Create your manager account

1. **Authentication → Users → Add user → Create new user**: `ryant@axsysinc.com`, a strong
   password, tick **Auto confirm user**.
2. In **SQL Editor**:
   ```sql
   update public.profiles
   set role = 'manager', full_name = 'Ryan T', annual_allowance = 15
   where email = 'ryant@axsysinc.com';
   ```
From now on, add everyone else from the portal's **Employees → Add employee** button.

## 5. Publish the manager portal

1. Get your keys: Supabase → **Project Settings → API**: copy the **Project URL** and the
   **anon / publishable** key (the anon key is safe to publish; the database's security
   rules do the protecting — never use the `service_role` key here).
2. Put them in `manager-portal/config.js`.
3. Host the `manager-portal` folder:
   - **Netlify**: <https://app.netlify.com/drop> → drag the `manager-portal` folder in.
   - **Cloudflare Pages**: Create project → Direct upload → upload the folder.
   Both read the included `_headers` file for security headers and give you HTTPS.
4. Optional: add a custom domain such as `timeoff.axsysinc.com` (a CNAME at your DNS
   provider), then make sure `PORTAL_URL` (step 3) matches.
5. Open the site and sign in with your manager account.

## 6. Build the Windows employee app

**Option A — GitHub builds it for you (recommended).**
1. Create a GitHub repository and push this whole folder to it.
2. Repo → Settings → Secrets and variables → Actions → add `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. Actions tab → **Build employee app** → **Run workflow**. When it finishes, download
   `Axsys-Time-Off-Setup` from the run's **Artifacts** — that's the installer `.exe`.

**Option B — build on any Windows PC.**
```powershell
cd employee-app
# put your URL + anon key in renderer\config.js first
npm install
npm run dist          # installer appears in employee-app\dist\
```

**Distributing:** share `Axsys-Time-Off-Setup-1.0.0.exe` (shared drive, email, Teams).
Employees double-click it and sign in with the email + temporary password you gave
them, then change the password under **Account & password**.

> Windows SmartScreen will say the publisher is unknown, because the installer isn't
> code-signed. Employees click **More info → Run anyway**. To remove the warning, buy a
> code-signing certificate and add it to the build (electron-builder docs: “Code Signing”).

**Automatic updates:** bump `"version"` in `employee-app/package.json`, commit, then
push a tag: `git tag v1.0.1 && git push --tags`. The workflow publishes a GitHub Release
and installed apps download it and offer “Restart & update”. Installed apps can only read
releases from a **public** repository — keep the code repo private if you like and
publish releases to a separate public repo by changing `build.publish` in `package.json`.

## 7. Check everything works

1. Portal → Employees → **Add employee** (use a second mailbox you can read).
2. Install the app, sign in as that employee, **Request time off**.
3. Within a few seconds you should get the email at ryant@axsysinc.com, and the request
   appears on the portal dashboard without refreshing.
4. Approve it → the employee gets an email and a Windows notification, and their totals update.
5. Portal → **Activity log → Email delivery** shows every send. If something says
   *Failed*, the reason is listed there (most often: the Resend domain isn't verified yet).
   Supabase → Edge Functions → `notify` → Logs has more detail.

---

## Everyday changes

| I want to… | Do this |
|---|---|
| Add a person / reset a password / deactivate someone | Portal → Employees |
| Change someone's yearly allowance | Portal → Employees → Edit |
| Make someone a manager | Portal → Employees → Edit → Role |
| Add an absence type (e.g. Bereavement) | SQL: `insert into absence_types (code,label,counts_toward_allowance,employee_requestable,color,sort_order) values ('bereavement','Bereavement',false,true,'#0f766e',5);` |
| Let employees request sick days themselves | SQL: `update absence_types set employee_requestable = true where code = 'sick';` |
| Change who gets request emails | `supabase secrets set MANAGER_EMAIL=a@axsysinc.com,b@axsysinc.com` |
| Replace the logo | Overwrite `manager-portal/assets/logo.svg` and `employee-app/renderer/logo.svg` (keep the names), redeploy / rebuild |
