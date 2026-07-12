from pathlib import Path
import re
from PIL import Image, ImageStat
from playwright.sync_api import sync_playwright

output = Path('artifacts')
output.mkdir(exist_ok=True)
errors = []
handled_source_errors = []

def verify_pixels(path: Path) -> None:
    variation = max(ImageStat.Stat(Image.open(path).convert('RGB')).var)
    assert variation > 25, f'Rendered screenshot appears blank: variance={variation}'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    def capture_console(message):
        if message.type != 'error':
            return
        if message.text == 'Failed to load resource: the server responded with a status of 504 (Gateway Timeout)':
            handled_source_errors.append(message.text)
        else:
            errors.append(message.text)
    page.on('console', capture_console)
    page.goto('http://127.0.0.1:4173', wait_until='domcontentloaded')
    page.get_by_text(re.compile(r'^(Public OSM context|Portland public GIS):')).wait_for(timeout=20000)
    canvas = page.locator('canvas')
    canvas.wait_for(state='visible')
    assert page.locator('.utility-toggle').is_checked()
    assert page.get_by_label('Type').input_value() == 'all'
    assert page.locator('.record-toggle').is_checked()
    for layer in ('Documents', 'DEQ', 'Zoning', 'Parcels', 'Aerial', 'Terrain'):
        assert page.get_by_label(layer).is_checked()
    box = canvas.bounding_box()
    assert box and box['width'] > 500 and box['height'] > 400, f'Unexpected canvas bounds: {box}'
    canvas_path = output / 'canvas-default.png'
    canvas.screenshot(path=str(canvas_path))
    verify_pixels(canvas_path)
    page.locator('input[type=file]').nth(0).set_input_files('scripts/map-export.fixture.json')
    page.get_by_text('Imported 2 geographic context records and recentered public map context.').wait_for()
    page.get_by_text(re.compile(r'^(Public OSM context|Portland public GIS):')).wait_for(timeout=20000)
    page.locator('input[type=file]').nth(1).set_input_files('scripts/evidence.fixture.json')
    page.get_by_text('Imported 1 sources, 1 claims, 1 events, 1 jobs, and 1 dependency claims.').wait_for()
    assert page.locator('.asset-row').filter(has_text='Example perimeter marker A').count() == 1
    page.locator('.utility-toggle').check()
    page.get_by_text('Public water main').wait_for()
    page.get_by_label('Type').select_option('sewer')
    assert page.get_by_text('Public sewer pipe').count() == 1
    page.locator('.record-toggle').check()
    page.get_by_text(re.compile(r'^Preview of .* nearby public permit records')).wait_for(timeout=20000)
    page.get_by_label('Aerial').check()
    page.locator('.layer-status summary').click()
    page.get_by_text(re.compile(r'^Aerial: (current|unavailable)')).wait_for(timeout=20000)
    page.get_by_label('Terrain').check()
    page.get_by_text(re.compile(r'^Terrain: (current|unavailable)')).wait_for(timeout=20000)
    page.locator('.asset-row').filter(has_text='Safety Eye SE-01').click()
    page.locator('h2').filter(has_text='Safety Eye SE-01').wait_for()
    assert page.locator('h2').inner_text() == 'Safety Eye SE-01'
    page.get_by_role('button', name='Isolate dependencies').click()
    assert 'active' in (page.get_by_role('button', name='Isolate dependencies').get_attribute('class') or '')
    page.get_by_role('button', name='specs').click()
    assert page.get_by_text('Record specification').count() == 1
    assert page.get_by_text('FIXTURE-SE-01').count() == 1
    page.get_by_role('button', name='history').click()
    assert page.get_by_text('Fixture inspection record').count() == 1
    page.get_by_role('button', name='jobs', exact=True).click()
    assert page.get_by_text('Fixture work order').count() == 1
    canvas.hover(position={'x': box['width'] / 2, 'y': box['height'] / 2})
    page.mouse.wheel(0, 900)
    canvas.screenshot(path=str(output / 'canvas-wide.png'))
    verify_pixels(output / 'canvas-wide.png')
    page.mouse.wheel(0, -1500)
    canvas.screenshot(path=str(output / 'canvas-close.png'))
    verify_pixels(output / 'canvas-close.png')
    desktop = output / 'desktop.png'
    page.screenshot(path=str(desktop), full_page=True)
    verify_pixels(desktop)

    mobile = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
    mobile.goto('http://127.0.0.1:4173', wait_until='domcontentloaded')
    mobile.locator('canvas').wait_for(state='visible')
    mobile.get_by_text(re.compile(r'^(Public OSM context|Portland public GIS):')).wait_for(timeout=20000)
    mobile.locator('.asset-row').filter(has_text='MCC-1 / 480V').click()
    assert mobile.locator('h2').inner_text() == 'MCC-1 / 480V'
    mobile_path = output / 'mobile.png'
    mobile.screenshot(path=str(mobile_path), full_page=True)
    verify_pixels(mobile_path)
    mobile.close()
    print(f'Canvas: {int(box["width"])}x{int(box["height"])}')
    print('Screenshots: desktop and mobile nonblank')
    print(f'Console errors: {errors}')
    print(f'Handled public-source timeouts: {len(handled_source_errors)}')
    browser.close()

assert not errors, f'Browser console errors: {errors}'
