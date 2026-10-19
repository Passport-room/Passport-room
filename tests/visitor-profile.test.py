import asyncio, mimetypes, json
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
Path('/tmp/browser/passport-tracker').mkdir(parents=True, exist_ok=True)
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True)
  context=await browser.new_context(viewport={'width':1280,'height':1800})
  async def serve(route):
   from urllib.parse import urlparse, unquote
   path=ROOT/unquote(urlparse(route.request.url).path).lstrip('/')
   if path.is_dir(): path=path/'index.html'
   if path.is_file(): await route.fulfill(path=str(path),content_type=mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
   else: await route.fulfill(status=404,body='Not found')
  await context.route('http://localhost:8080/**',serve)
  page=await context.new_page(); errors=[]; auth_calls=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('request',lambda r:auth_calls.append(1) if 'identitytoolkit.googleapis.com' in r.url else None)
  await page.goto('http://localhost:8080/',wait_until='domcontentloaded')
  await page.get_by_role('button',name='Reject',exact=True).click()
  await page.get_by_role('button',name='Got it',exact=True).click()
  await page.wait_for_timeout(1500)
  assert len(auth_calls)==0,'Auth must not start after rejection'
  await page.locator('#profileBtn').click()
  await page.locator('#accountDrawer').wait_for(state='visible')
  assert await page.locator('#visitorUid').inner_text()=='Not assigned'
  await page.locator('#visitorProfile').screenshot(path='/tmp/browser/passport-tracker/rejected.png')
  await page.locator('#accountDrawer [data-close-drawer]').click()
  await page.wait_for_timeout(500)
  await page.get_by_role('button',name='Cookie settings').click(force=True)
  await page.get_by_role('button',name='Accept all',exact=True).click()
  await page.wait_for_function("document.getElementById('visitorStatus').textContent.includes('Firebase visitor account active')",timeout=60000)
  before=json.loads(await page.evaluate("localStorage.getItem('pr_anonymous_visitor_v1')"))
  assert len(before['uid'])>=20 and before['visits']==1
  await page.locator('#profileBtn').click()
  assert await page.locator('#visitorUid').inner_text()==before['uid']
  await page.wait_for_timeout(500)
  await page.locator('#visitorProfile').screenshot(path='/tmp/browser/passport-tracker/accepted.png')
  await page.reload(wait_until='domcontentloaded')
  await page.wait_for_function("document.getElementById('visitorStatus').textContent.includes('Firebase visitor account active')",timeout=60000)
  after=json.loads(await page.evaluate("localStorage.getItem('pr_anonymous_visitor_v1')"))
  assert after['uid']==before['uid'] and after['name']==before['name'] and after['visits']==2
  await page.set_viewport_size({'width':360,'height':655})
  await page.locator('#profileBtn').click()
  await page.wait_for_timeout(350)
  await page.locator('#accountDrawer').screenshot(path='/tmp/browser/passport-tracker/mobile-profile.png')
  box=await page.locator('#visitorProfile').bounding_box()
  assert box and box['width']<=360
  await page.locator('#accountDrawer [data-close-drawer]').click()
  await page.wait_for_timeout(500)
  await page.get_by_role('button',name='Cookie settings').click(force=True)
  await page.get_by_role('button',name='Reject',exact=True).click()
  await page.wait_for_timeout(1000)
  assert await page.evaluate("localStorage.getItem('pr_anonymous_visitor_v1')") is None
  assert await page.locator('#visitorUid').inner_text()=='Not assigned'
  print('PASS: real Firebase UID, random name, reload persistence, 1→2 visits, rejection before auth, consent withdrawal, mobile panel.')
  print('Page errors:',errors)
  assert not errors
  await browser.close()
asyncio.run(main())
