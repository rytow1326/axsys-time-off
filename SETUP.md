# Quick setup — about 15 minutes, nothing to install

You only need two free accounts: **Supabase** (where everyone's time off is stored) and
**GitHub** (which builds the installer and hosts the manager portal for you).
Email is optional and can be switched on later.

---

### 1. Supabase — the shared database (5 min)

1. Sign up at **supabase.com** → **New project**.
   Name: `axsys-time-off` · Database password: click **Generate** (you won't need it again) · Region: **East US**.
2. When it's ready, copy the **Project ref** — the random code in the address bar after
   `/project/` (e.g. `abcdefghijklmnopqrst`).
3. Click your avatar (top right) → **Account preferences → Access Tokens → Generate new token**.
   Name it `github-deploy` and copy it.

### 2. GitHub — put the project online (5 min)

1. Sign up / sign in at **github.com** → **New repository** → name `axsys-time-off` → **Public** → Create.
   *(Public is what lets installed apps update themselves and keeps the portal hosting free.
   No passwords or keys are stored in the code — they go in step 3.)*
2. On the new repo page click **uploading an existing file**, then drag in **everything inside**
   the unzipped `axsys-time-off` folder → **Commit changes**.
   Check that a `.github` folder appears in the file list. If it doesn't, click **Add file → Create
   new file**, type `.github/workflows/deploy.yml` as the name, paste in the contents of that file, and commit.

### 3. Add your keys (3 min)

Repo → **Settings → Secrets and variables → Actions → New repository secret**, three times:

| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | the token from step 1.3 |
| `SUPABASE_PROJECT_REF` | the project ref from step 1.2 |
| `MANAGER_PASSWORD` | the password you want for your own manager login (10+ characters) |

Then **Settings → Pages → Source → GitHub Actions**.

### 4. Press the button

Repo → **Actions** tab → **Deploy** → **Run workflow** → **Run workflow**.

It takes about 8–10 minutes. When it turns green, open the run — the summary at the top has:
- **Manager portal link** — sign in with ryant@axsysinc.com and your `MANAGER_PASSWORD`
- **Installer link** — send this to employees; they download, run, and sign in

Then in the portal go to **Employees → Add employee** for each person. It gives you a temporary
password to pass along.

---

## Turning on email (whenever you're ready)

1. Sign up at **resend.com** using **ryant@axsysinc.com** → **API Keys → Create** → copy it.
2. Add it as a repository secret named `RESEND_API_KEY`, then run **Deploy** again.

From then on, every new / changed / cancelled request emails you immediately.

To also email **employees** when you approve or deny (they always get an in-app notification
regardless), Resend needs to confirm you own axsysinc.com: in Resend → **Domains → Add domain**,
give the DNS records it shows to whoever manages axsysinc.com. Once it says *Verified*, add a secret
`EMAIL_FROM` = `Axsys Time Off <timeoff@axsysinc.com>` and run **Deploy** again.

## Making changes later

- Any change to the files → commit it → run **Deploy** again. It's safe to run as often as you like.
- New version of the employee app → bump `"version"` in `employee-app/package.json` (e.g. `1.0.1`)
  before running Deploy. Installed apps pick it up automatically and show **Restart & update**.

## If something goes wrong

Open the failed run in the **Actions** tab — the red step explains what's missing (most often a
secret name typo or Pages not set to *GitHub Actions*). Fix it and click **Re-run all jobs**.

Prefer to set things up by hand or host elsewhere? See [docs/MANUAL-SETUP.md](docs/MANUAL-SETUP.md).
