<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Preserve Passport Room's photo studio as the self-contained `public/index.html` served through the `/` redirect, because its browser-side photo tools and established content pages depend on those static assets.
- Keep the four advertising placements in the studio and load AdSense only when a placement is visible; Pro members never see ads, matching the existing membership behavior.
