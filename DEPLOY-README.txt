Passport Room — Vercel-ready site
=================================

What is inside
--------------
- The complete website with your latest fixes: no phone number, address
  "Jamalpur, Dhaka, Bangladesh", email support.passport.room@gmail.com
  on every page (Contact, Privacy, Refund, Terms, About, home).
- vercel.json — the same security headers the site had before, converted
  to Vercel's format.

How to deploy on Vercel
-----------------------
Option A (easiest): go to vercel.com → Add New → Project → drag this
folder (or upload the zip contents) → Framework preset: "Other" → Deploy.

Option B (CLI): install Node, then:
  npm i -g vercel
  vercel --prod
inside this folder.

No build step is needed — everything is prebuilt. The deploy only needs
the files in this folder.
