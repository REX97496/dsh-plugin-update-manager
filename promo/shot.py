import sys, pathlib
from playwright.sync_api import sync_playwright

comp = pathlib.Path(sys.argv[1]).resolve()
times = [float(x) for x in sys.argv[2].split(',')]
out = pathlib.Path(sys.argv[3]).resolve()
out.parent.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--allow-file-access-from-files'])
    pg = b.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
    errs = []
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    pg.goto(comp.as_uri())
    pg.wait_for_timeout(1500)
    for t in times:
        pg.evaluate(f'window.__seek({t})')
        pg.wait_for_timeout(150)
        pg.screenshot(path=str(out.with_name(f'{out.stem}-{t:07.2f}.png')))
    print('page errors:', errs[:4] or 'none')
    b.close()
