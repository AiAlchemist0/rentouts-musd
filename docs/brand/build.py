"""Builds the RentOuts hex-house brand kit. Run from anywhere: python docs/brand/build.py

Writes SVG + PNG files into docs/brand/kit/ and copies the web icons into app/public/.
Needs: playwright (chromium), Pillow.
"""
import base64
import math
import pathlib
import shutil

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
KIT = HERE / "kit"
PUBLIC = HERE.parents[1] / "app" / "public"
KIT.mkdir(exist_ok=True)

EMERALD_LIGHT, EMERALD_DARK, EMERALD = "#2BB583", "#0A7552", "#20976C"
INK, PAPER, NIGHT = "#171C26", "#FBFAF8", "#11161D"
GRAD = (f'<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="64" y2="64">'
        f'<stop offset="0" stop-color="{EMERALD_LIGHT}"/><stop offset="1" stop-color="{EMERALD_DARK}"/></linearGradient>')


def hex_points(cx, cy, r):
    return " ".join(f"{cx + r * math.sin(math.radians(a)):.2f},{cy - r * math.cos(math.radians(a)):.2f}"
                    for a in range(0, 360, 60))


def keyhole(cx, cy, r):
    """One closed keyhole outline: round head, tapered slot."""
    a = 0.38 * r
    jy = cy + math.sqrt(r * r - a * a)
    by, bw = cy + 2.7 * r, 0.75 * r
    return (f"M{cx - a:.2f} {jy:.2f}A{r} {r} 0 1 1 {cx + a:.2f} {jy:.2f}"
            f"L{cx + bw:.2f} {by:.2f}H{cx - bw:.2f}Z")


def svg(body, defs="", vb="0 0 64 64"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"><defs>{defs}</defs>{body}</svg>'


# App icon: emerald tile, white hex house, emerald keyhole.
ICON = svg(f'<rect width="64" height="64" rx="15" fill="url(#g)"/>'
           f'<polygon points="{hex_points(32, 33, 20)}" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>'
           f'<path d="{keyhole(32, 30.5, 5)}" fill="url(#g)"/>', GRAD)


def bare(color, cut_id="k"):
    """Hex house alone (keyhole cut out, transparent), for headers and small UI."""
    mask = (f'<mask id="{cut_id}"><polygon points="{hex_points(32, 32, 28)}" fill="#fff" stroke="#fff" '
            f'stroke-width="4" stroke-linejoin="round"/><path d="{keyhole(32, 28.4, 7.25)}" fill="#000"/></mask>')
    return svg(f'<rect width="64" height="64" fill="{color}" mask="url(#{cut_id})"/>', mask)


FILES = {
    "rentouts-icon.svg": ICON,
    "rentouts-mark-emerald.svg": bare(EMERALD),
    "rentouts-mark-white.svg": bare("#ffffff"),
    "rentouts-mark-ink.svg": bare(INK),
}


def wordmark_svg(dark):
    rent = "#ffffff" if dark else INK
    outs = "#3FD29C" if dark else EMERALD
    return svg(f'{ICON[ICON.index(">") + 1:-6].replace("<defs>", "").replace("</defs>", "")}'
               f'<text x="80" y="45" font-family="Inter, Segoe UI, Arial, sans-serif" font-weight="800" '
               f'font-size="40" letter-spacing="-1.4"><tspan fill="{rent}">Rent</tspan><tspan fill="{outs}">Outs</tspan></text>',
               GRAD, vb="0 0 290 64")


FILES["rentouts-logo-horizontal.svg"] = wordmark_svg(False)
FILES["rentouts-logo-horizontal-dark.svg"] = wordmark_svg(True)
for name, body in FILES.items():
    (KIT / name).write_text(body, encoding="utf-8")

def uri(p):
    return 'data:image/svg+xml;base64,' + base64.b64encode(pathlib.Path(p).read_bytes()).decode()


FONT = "<link href='https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&display=swap' rel='stylesheet'>"

OG = f"""<html><head>{FONT}<style>
body{{margin:0;width:1200px;height:630px;font-family:Inter,sans-serif;background:{PAPER};color:{INK};position:relative;overflow:hidden}}
.glow{{position:absolute;right:-180px;top:-220px;width:760px;height:760px;border-radius:50%;
background:radial-gradient(circle,rgba(43,181,131,.22),rgba(43,181,131,0) 65%)}}
.mark{{position:absolute;right:84px;top:200px;width:270px;height:270px}}
.brand{{position:absolute;left:88px;top:64px;display:flex;align-items:center;gap:14px;font-weight:800;font-size:34px;letter-spacing:-1px}}
.brand img{{width:52px;height:52px}} .brand b{{color:{EMERALD}}} .brand i{{font-style:normal;font-weight:500;color:#6b7280;font-size:26px;margin-left:6px}}
.pill{{position:absolute;left:88px;top:176px;background:#E7F6EF;color:#0A7552;border:1px solid #BFE6D4;border-radius:999px;padding:8px 18px;font-weight:700;font-size:20px}}
h1{{position:absolute;left:88px;top:240px;margin:0;font-size:76px;line-height:1.04;letter-spacing:-3px;font-weight:800}}
h1 span{{color:#0A7552}}
p{{position:absolute;left:88px;top:436px;width:640px;margin:0;font-size:25px;line-height:1.45;color:#4b5563}}
.foot{{position:absolute;left:88px;bottom:40px;font-size:18px;color:#6b7280}}
</style></head><body><div class="glow"></div>
<img class="mark" src="{uri(KIT / 'rentouts-icon.svg')}">
<div class="brand"><img src="{uri(KIT / 'rentouts-icon.svg')}"><span>Rent<b>Outs</b></span><i>× Mezo</i></div>
<div class="pill">Mezo Buildathon · Wave 2</div>
<h1>Keep your bitcoin.<br><span>Pay your rent.</span></h1>
<p>Rent and deposits in MUSD, paid monthly from your own Mezo trove through a non-custodial escrow.</p>
<div class="foot">mezo.rentouts.co · github.com/AiAlchemist0/rentouts-musd · rentouts.co</div>
</body></html>"""

SHEET = f"""<html><head>{FONT}<style>
body{{margin:0;font-family:Inter,sans-serif;background:{PAPER};color:{INK};width:1400px}}
section{{display:flex;gap:44px;align-items:center;padding:36px 48px;border-bottom:1px solid #eee}}
section.dark{{background:{NIGHT};color:#fff}} h2{{width:190px;margin:0;font-size:17px;font-weight:700}}
</style></head><body>
<section><h2>App icon</h2>""" + "".join(
    f'<img src="{uri(KIT / "rentouts-icon.svg")}" width="{s}">' for s in (160, 64, 32, 16)) + f"""</section>
<section><h2>Mark (emerald / ink)</h2><img src="{uri(KIT / 'rentouts-mark-emerald.svg')}" width="120"><img src="{uri(KIT / 'rentouts-mark-emerald.svg')}" width="26"><img src="{uri(KIT / 'rentouts-mark-ink.svg')}" width="120"></section>
<section class="dark"><h2>Mark (white)</h2><img src="{uri(KIT / 'rentouts-mark-white.svg')}" width="120"><img src="{uri(KIT / 'rentouts-mark-white.svg')}" width="26"></section>
<section><h2>Horizontal</h2><img src="file-h" height="72"></section>
<section class="dark"><h2>Horizontal (dark)</h2><img src="file-hd" height="72"></section>
</body></html>"""


def shot(page, html, path, w, h, transparent=False, full=False):
    page.set_viewport_size({"width": w, "height": h})
    page.set_content(html)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    page.screenshot(path=str(path), omit_background=transparent, full_page=full)


def img_page(src, w, h):
    return f'<html><body style="margin:0;background:transparent"><img src="{uri(src)}" width="{w}" height="{h}"></body></html>'


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page()
    for size in (16, 32, 180, 192, 512, 1024):
        shot(page, img_page(KIT / "rentouts-icon.svg", size, size), KIT / f"rentouts-icon-{size}.png", size, size, True)
    for color in ("emerald", "white", "ink"):
        shot(page, img_page(KIT / f"rentouts-mark-{color}.svg", 512, 512), KIT / f"rentouts-mark-{color}-512.png", 512, 512, True)
    for name in ("rentouts-logo-horizontal", "rentouts-logo-horizontal-dark"):
        html = (f"<html><head>{FONT}</head><body style='margin:0;background:transparent'>"
                f"{(KIT / (name + '.svg')).read_text(encoding='utf-8').replace('<svg ', '<svg width=1160 height=256 ')}</body></html>")
        shot(page, html, KIT / f"{name}.png", 1160, 256, True)
    shot(page, OG, KIT / "og.png", 1200, 630)
    png = lambda n: "data:image/png;base64," + base64.b64encode((KIT / n).read_bytes()).decode()
    sheet = SHEET.replace("file-hd", png("rentouts-logo-horizontal-dark.png")).replace("file-h", png("rentouts-logo-horizontal.png"))
    shot(page, sheet, HERE / "brand-sheet.png", 1400, 900, full=True)
    browser.close()

Image.open(KIT / "rentouts-icon-512.png").save(KIT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

# Web icons for mezo.rentouts.co
shutil.copy(KIT / "rentouts-icon.svg", PUBLIC / "favicon.svg")
shutil.copy(KIT / "favicon.ico", PUBLIC / "favicon.ico")
shutil.copy(KIT / "rentouts-icon-180.png", PUBLIC / "apple-touch-icon.png")
shutil.copy(KIT / "rentouts-icon-192.png", PUBLIC / "icon-192.png")
shutil.copy(KIT / "rentouts-icon-512.png", PUBLIC / "icon-512.png")
shutil.copy(KIT / "og.png", PUBLIC / "og.png")
print("kit:", sorted(p.name for p in KIT.iterdir()))
