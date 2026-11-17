import pathlib, sys
from playwright.sync_api import sync_playwright

comp = pathlib.Path(sys.argv[1]).resolve()
outdir = pathlib.Path(sys.argv[2]).resolve()
outdir.mkdir(parents=True, exist_ok=True)

SHOTS = [
    ('h', 1920, 1080, 'cover-16x9-1920x1080.png'),
    ('v', 1080, 1920, 'cover-9x16-1080x1920.png'),
    ('r', 1440, 1080, 'cover-4x3-1440x1080.png'),
    ('t', 1080, 1440, 'cover-3x4-1080x1440.png'),
]

with sync_playwright() as p:
    b = p.chromium.launch(args=['--allow-file-access-from-files'])
    errs = []
    for name, w, h, fname in SHOTS:
        pg = b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=1)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(comp.as_uri() + '#' + name)
        pg.wait_for_timeout(1300)
        pg.evaluate(f"window.__layout('{name}')")
        pg.wait_for_timeout(250)
        pg.screenshot(path=str(outdir / fname))
        pg.close()
    print('page errors:', errs or 'none')
    b.close()
