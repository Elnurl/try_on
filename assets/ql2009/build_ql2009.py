"""
QL2009 C1 — manual hard-surface build for DeepAR / Web AR.

Traces the official front photo (inner rim lock), mirrors one half,
and uses conservative assumed depth. No AI mesh. No photogrammetry.

Run:
  blender --background --python assets/ql2009/build_ql2009.py
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parent
EXPORT = ROOT / "export"
SILHOUETTE = ROOT / "front_silhouette.json"
FRONT_PHOTO = ROOT / "2009 C1 (2).png"

# --- Locked from front photo + lens stamp ---------------------------------
A_MM = 49.0
DBL_STAMP_MM = 18.0
TEMPLE_LEN_MM = 142.0

# Rim width measured on the photo at 6 o'clock (inner vs outer): ~1.44 mm.
# Use 1.7 mm so the thin Ultem rim stays visible in AR without going chunky.
RIM_WIDTH_MM = 1.7
# No true top view. Conservative injected-Ultem depth.
RIM_DEPTH_MM = 3.4
# Almost-flat front. Catalog 3/4 does not show a strong wrap.
WRAP_DEG = 2.5

# Lens
LENS_THICK_MM = 1.6
LENS_SAGITTA_MM = 1.15  # low base-curve demo lens; not measured

# Temple (3/4 photo: wire-thin, slight flatten, gentle ear bend)
TEMPLE_W0, TEMPLE_H0 = 2.2, 4.0
TEMPLE_W1, TEMPLE_H1 = 2.0, 3.2
TEMPLE_TIP_W, TEMPLE_TIP_H = 3.6, 2.6
EAR_BEND_START = 0.70
EAR_DROP_MM = 20.0
TEMPLE_INSET_MM = 6.0

# Topology
RIM_SEGS = 64
RIM_PROFILE = 10
BRIDGE_SEGS = 16
BRIDGE_PROFILE = 8
TEMPLE_SEGS = 36
TEMPLE_PROFILE = 12
LENS_RINGS = 10

# Materials
FRAME_COLOR = (0.018, 0.018, 0.018, 1.0)
FRAME_ROUGH = 0.65
LENS_IOR = 1.50


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.meshes):
        bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        bpy.data.materials.remove(block)
    for block in list(bpy.data.images):
        if block.users == 0:
            bpy.data.images.remove(block)


def setup_units() -> None:
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = "MILLIMETERS"


def load_right_inner() -> list[Vector]:
    data = json.loads(SILHOUETTE.read_text(encoding="utf-8"))
    pts = [Vector((p["x"], p["y"], 0.0)) for p in data["right_inner"]]
    # Moving-average smooth (photo trace noise), keep panto / keyhole.
    smooth: list[Vector] = []
    n = len(pts)
    for i in range(n):
        acc = Vector((0, 0, 0))
        for k in (-1, 0, 1):
            acc += pts[(i + k) % n]
        smooth.append(acc / 3.0)
    # Resample to RIM_SEGS on accumulated length.
    return resample_closed(smooth, RIM_SEGS)


def resample_closed(pts: list[Vector], count: int) -> list[Vector]:
    dists = [0.0]
    for i in range(len(pts)):
        dists.append(dists[-1] + (pts[(i + 1) % len(pts)] - pts[i]).length)
    total = dists[-1]
    out: list[Vector] = []
    for j in range(count):
        target = total * j / count
        k = 0
        while k < len(pts) and dists[k + 1] < target:
            k += 1
        span = max(dists[k + 1] - dists[k], 1e-8)
        t = (target - dists[k]) / span
        out.append(pts[k].lerp(pts[(k + 1) % len(pts)], t))
    return out


def outward_normals(inner: list[Vector]) -> list[Vector]:
    n = len(inner)
    out: list[Vector] = []
    for i in range(n):
        tangent = (inner[(i + 1) % n] - inner[(i - 1) % n]).normalized()
        # Inward-left of tangent in XY → rotate 90° CW in XY to point outward
        # for a CCW loop. Photo trace is CCW starting at +X.
        nor = Vector((tangent.y, -tangent.x, 0.0))
        # Ensure it points away from the local centroid of the right lens.
        centroid = sum(inner, Vector()) / n
        if (inner[i] + nor - centroid).length < (inner[i] - nor - centroid).length:
            nor = -nor
        out.append(nor.normalized())
    return out


def apply_wrap(p: Vector) -> Vector:
    """Slight yaw of each half around Y so the front is not a perfect plane."""
    if WRAP_DEG <= 0:
        return p.copy()
    # Positive X rotates toward -Z (wrap around the face).
    ang = math.radians(WRAP_DEG) * (1.0 if p.x >= 0 else -1.0)
    rot = Matrix.Rotation(-ang, 4, "Y")
    return rot @ p


def lug_extra(i: int, n: int) -> float:
    """Small temporal lug. Angle 0 is +X (outer)."""
    ang = 2.0 * math.pi * i / n
    # Temporal-top quadrant, ~ -25° to +15°.
    a = (ang + math.pi) % (2 * math.pi) - math.pi
    if -0.50 <= a <= 0.32:
        t = 1.0 - abs((a + 0.06) / 0.42)
        return 3.4 * max(0.0, t) ** 1.25
    return 0.0


def ellipse_profile(outward: Vector, tangent: Vector, w: float, h: float, k: int, n: int) -> Vector:
    z_axis = tangent.cross(outward)
    if z_axis.length < 1e-6:
        z_axis = Vector((0, 0, 1))
    z_axis.normalize()
    side = z_axis.cross(tangent).normalized()
    a = 2.0 * math.pi * k / n
    return side * (w * 0.5 * math.cos(a)) + z_axis * (h * 0.5 * math.sin(a))


def build_tube(
    name: str,
    centerline: list[Vector],
    outwards: list[Vector],
    widths: list[float],
    depths: list[float],
    n_profile: int,
    closed: bool,
) -> bpy.types.Object:
    verts: list[Vector] = []
    faces: list[tuple[int, int, int, int]] = []
    n = len(centerline)
    for i in range(n):
        prev_i = (i - 1) % n if closed else max(0, i - 1)
        next_i = (i + 1) % n if closed else min(n - 1, i + 1)
        tangent = (centerline[next_i] - centerline[prev_i]).normalized()
        if tangent.length < 1e-6:
            tangent = Vector((0, 0, -1))
        for k in range(n_profile):
            verts.append(
                centerline[i]
                + ellipse_profile(outwards[i], tangent, widths[i], depths[i], k, n_profile)
            )
    ring_count = n if closed else n
    segs = n if closed else n - 1
    for i in range(segs):
        i0 = i
        i1 = (i + 1) % n if closed else i + 1
        for k in range(n_profile):
            a = i0 * n_profile + k
            b = i0 * n_profile + (k + 1) % n_profile
            c = i1 * n_profile + (k + 1) % n_profile
            d = i1 * n_profile + k
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def build_right_rim(inner: list[Vector]) -> tuple[bpy.types.Object, list[Vector], list[Vector]]:
    nors = outward_normals(inner)
    n = len(inner)
    outer: list[Vector] = []
    center: list[Vector] = []
    widths: list[float] = []
    depths: list[float] = []
    outwards: list[Vector] = []
    for i in range(n):
        extra = lug_extra(i, n)
        w = RIM_WIDTH_MM + extra * 0.15
        o = apply_wrap(inner[i] + nors[i] * (RIM_WIDTH_MM + extra))
        inn = apply_wrap(inner[i])
        c = (inn + o) * 0.5
        outer.append(o)
        center.append(c)
        widths.append(w)
        depths.append(RIM_DEPTH_MM + extra * 0.2)
        outwards.append((o - inn).normalized())
    obj = build_tube("QL2009_rim_R", center, outwards, widths, depths, RIM_PROFILE, True)
    return obj, inner, center


def build_half_bridge(inner: list[Vector]) -> bpy.types.Object:
    """Keyhole top bar: from nasal-top of the right rim to X=0. No pads."""
    # Inner points near the top-nasal (upper-left of the right lens).
    # Photo: bridge bar sits below the rim crown (about +15 to +18 mm),
    # not above the top of the lenses.
    candidates = [p for p in inner if 11.0 < p.x < 20.0 and 13.0 < p.y < 20.0]
    if not candidates:
        attach = min(inner, key=lambda p: (p.x - 14.5) ** 2 + (p.y - 16.5) ** 2)
    else:
        attach = min(candidates, key=lambda p: (p.y - 16.2) ** 2 + (p.x - 14.0) ** 2)
    attach = apply_wrap(attach + Vector((-0.1, 0.85, 0.0)))
    mid = Vector((attach.x * 0.40, 18.0, attach.z + 0.1))
    end = Vector((0.0, 18.6, 0.15))
    raw = [attach, mid, end]
    pts = resample_open(raw, BRIDGE_SEGS)
    outwards = []
    for i, p in enumerate(pts):
        # Outward for the bridge is mostly +Y (top of the keyhole).
        outwards.append(Vector((0.15, 1.0, 0.0)).normalized())
    widths = [RIM_WIDTH_MM * 1.05] * len(pts)
    depths = [RIM_DEPTH_MM * 0.95] * len(pts)
    return build_tube("QL2009_bridge_R", pts, outwards, widths, depths, BRIDGE_PROFILE, False)


def resample_open(pts: list[Vector], count: int) -> list[Vector]:
    dists = [0.0]
    for i in range(len(pts) - 1):
        dists.append(dists[-1] + (pts[i + 1] - pts[i]).length)
    total = max(dists[-1], 1e-6)
    out: list[Vector] = []
    for j in range(count):
        target = total * j / (count - 1)
        k = 0
        while k < len(pts) - 2 and dists[k + 1] < target:
            k += 1
        span = max(dists[k + 1] - dists[k], 1e-8)
        t = (target - dists[k]) / span
        out.append(pts[k].lerp(pts[k + 1], t))
    return out


def temple_path(hinge: Vector) -> list[Vector]:
    pts: list[Vector] = []
    for i in range(TEMPLE_SEGS):
        t = i / (TEMPLE_SEGS - 1)
        z = -t * TEMPLE_LEN_MM
        y = hinge.y
        x = hinge.x
        if t > EAR_BEND_START:
            u = (t - EAR_BEND_START) / (1.0 - EAR_BEND_START)
            s = u * u * (3.0 - 2.0 * u)
            y = hinge.y - EAR_DROP_MM * s
            x = hinge.x - TEMPLE_INSET_MM * s
        # Keep the first 8 mm attached to the lug.
        pts.append(Vector((x, y, hinge.z + z)))
    return pts


def build_right_temple(center: list[Vector], inner: list[Vector]) -> bpy.types.Object:
    n = len(center)
    # Hinge = temporal-most centerline point, slightly toward the top.
    scored = []
    for i, p in enumerate(center):
        scored.append((p.x + 0.25 * p.y, i, p))
    scored.sort(reverse=True)
    hinge = scored[0][2].copy()
    hinge.z = 0.0
    path = temple_path(hinge)
    outwards: list[Vector] = []
    widths: list[float] = []
    depths: list[float] = []
    for i, p in enumerate(path):
        t = i / (len(path) - 1)
        # Local "outward" is +X / world-up mix so the temple stays upright.
        outwards.append(Vector((1.0, 0.15, 0.0)).normalized())
        if t < 0.82:
            u = t / 0.82
            widths.append(TEMPLE_W0 * (1 - u) + TEMPLE_W1 * u)
            depths.append(TEMPLE_H0 * (1 - u) + TEMPLE_H1 * u)
        else:
            u = (t - 0.82) / 0.18
            widths.append(TEMPLE_W1 * (1 - u) + TEMPLE_TIP_W * u)
            depths.append(TEMPLE_H1 * (1 - u) + TEMPLE_TIP_H * u)
    return build_tube("QL2009_temple_R", path, outwards, widths, depths, TEMPLE_PROFILE, False)


def build_right_lens(inner: list[Vector]) -> bpy.types.Object:
    n = len(inner)
    centroid = sum((apply_wrap(p) for p in inner), Vector()) / n
    verts: list[Vector] = []
    faces: list[tuple] = []

    def ring_point(p: Vector, r: float) -> tuple[Vector, Vector]:
        q = apply_wrap(p)
        xy = centroid.lerp(q, r)
        # Radial factor in the lens plane.
        local = (p - (sum(inner, Vector()) / n))
        rr = min(1.0, local.length / max((inner[j] - sum(inner, Vector()) / n).length for j in range(n)))
        sag = LENS_SAGITTA_MM * (1.0 - (r * r))
        front = Vector((xy.x, xy.y, xy.z + sag + 0.15))
        back = Vector((xy.x, xy.y, xy.z + sag + 0.15 - LENS_THICK_MM))
        return front, back

    # Rings 0 = center, RINGS = rim
    fronts: list[list[int]] = []
    backs: list[list[int]] = []
    # center
    cf, cb = ring_point(inner[0], 0.0)
    # true center
    sag = LENS_SAGITTA_MM
    cxy = apply_wrap(sum(inner, Vector()) / n)
    fi = len(verts)
    verts.append(Vector((cxy.x, cxy.y, cxy.z + sag + 0.15)))
    bi = len(verts)
    verts.append(Vector((cxy.x, cxy.y, cxy.z + sag + 0.15 - LENS_THICK_MM)))
    fronts.append([fi])
    backs.append([bi])
    for ring in range(1, LENS_RINGS + 1):
        r = ring / LENS_RINGS
        fr: list[int] = []
        br: list[int] = []
        for i in range(n):
            f, b = ring_point(inner[i], r)
            fr.append(len(verts))
            verts.append(f)
            br.append(len(verts))
            verts.append(b)
        fronts.append(fr)
        backs.append(br)

    # Front fan / quads
    for i in range(n):
        faces.append((fronts[0][0], fronts[1][i], fronts[1][(i + 1) % n]))
    for ring in range(1, LENS_RINGS):
        a, b = fronts[ring], fronts[ring + 1]
        for i in range(n):
            i1 = (i + 1) % n
            faces.append((a[i], b[i], b[i1], a[i1]))
    # Back (reversed winding)
    for i in range(n):
        faces.append((backs[0][0], backs[1][(i + 1) % n], backs[1][i]))
    for ring in range(1, LENS_RINGS):
        a, b = backs[ring], backs[ring + 1]
        for i in range(n):
            i1 = (i + 1) % n
            faces.append((a[i], a[i1], b[i1], b[i]))
    # Rim wall
    a, b = fronts[-1], backs[-1]
    for i in range(n):
        i1 = (i + 1) % n
        faces.append((a[i], a[i1], b[i1], b[i]))

    mesh = bpy.data.meshes.new("QL2009_lens_R")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.update()
    obj = bpy.data.objects.new("QL2009_lens_R", mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def make_materials() -> tuple[bpy.types.Material, bpy.types.Material]:
    frame = bpy.data.materials.new("QL2009_Ultem_MatteBlack")
    frame.use_nodes = True
    nt = frame.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = FRAME_COLOR
    bsdf.inputs["Roughness"].default_value = FRAME_ROUGH
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.25
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    frame.diffuse_color = FRAME_COLOR

    lens = bpy.data.materials.new("QL2009_Lens_Clear")
    lens.use_nodes = True
    lens.blend_method = "BLEND"
    lens.use_screen_refraction = True
    nt = lens.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.95, 0.97, 0.99, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.04
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["IOR"].default_value = LENS_IOR
    bsdf.inputs["Transmission Weight"].default_value = 1.0
    bsdf.inputs["Alpha"].default_value = 0.12
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    lens.diffuse_color = (0.7, 0.8, 0.9, 0.2)
    return frame, lens


def assign_mat(obj: bpy.types.Object, mat: bpy.types.Material) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def shade_smooth(obj: bpy.types.Object) -> None:
    mesh = obj.data
    values = [True] * len(mesh.polygons)
    mesh.polygons.foreach_set("use_smooth", values)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.object.shade_smooth()
    except Exception:
        pass


def join_objects(name: str, objs: list[bpy.types.Object]) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    objs[0].name = name
    return objs[0]


def apply_mirror(obj: bpy.types.Object) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new("Mirror", "MIRROR")
    mod.use_axis[0] = True
    mod.use_clip = True
    mod.merge_threshold = 0.05
    bpy.ops.object.modifier_apply(modifier="Mirror")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.05)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def count_tris(obj: bpy.types.Object) -> int:
    mesh = obj.data
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def bounds_mm(obj: bpy.types.Object) -> dict:
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    xs = [c.x for c in corners]
    ys = [c.y for c in corners]
    zs = [c.z for c in corners]
    return {
        "x_min": round(min(xs), 2),
        "x_max": round(max(xs), 2),
        "y_min": round(min(ys), 2),
        "y_max": round(max(ys), 2),
        "z_min": round(min(zs), 2),
        "z_max": round(max(zs), 2),
        "width": round(max(xs) - min(xs), 2),
        "height": round(max(ys) - min(ys), 2),
        "depth": round(max(zs) - min(zs), 2),
    }


def setup_world() -> None:
    world = bpy.data.worlds.new("Studio")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.22, 0.22, 0.24, 1.0)
    bg.inputs[1].default_value = 0.55
    # Key + fill so matte black reads on a dark studio, including top/side.
    key = bpy.data.lights.new("key", "AREA")
    key.energy = 250.0
    key.size = 180.0
    key_obj = bpy.data.objects.new("key", key)
    key_obj.location = (80.0, 120.0, 160.0)
    key_obj.rotation_euler = (math.radians(50), 0.0, math.radians(25))
    bpy.context.collection.objects.link(key_obj)
    fill = bpy.data.lights.new("fill", "AREA")
    fill.energy = 80.0
    fill.size = 220.0
    fill_obj = bpy.data.objects.new("fill", fill)
    fill_obj.location = (-100.0, 40.0, 80.0)
    fill_obj.rotation_euler = (math.radians(70), 0.0, math.radians(-35))
    bpy.context.collection.objects.link(fill_obj)
    rim = bpy.data.lights.new("rim", "AREA")
    rim.energy = 60.0
    rim.size = 160.0
    rim_obj = bpy.data.objects.new("rim", rim)
    rim_obj.location = (0.0, 160.0, -80.0)
    rim_obj.rotation_euler = (math.radians(-70), 0.0, 0.0)
    bpy.context.collection.objects.link(rim_obj)


def add_camera(name: str, loc: Vector, rot_deg: tuple[float, float, float], ortho_scale: float) -> bpy.types.Object:
    cam = bpy.data.cameras.new(name)
    cam.type = "ORTHO"
    cam.ortho_scale = ortho_scale
    obj = bpy.data.objects.new(name, cam)
    obj.location = loc
    obj.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    bpy.context.collection.objects.link(obj)
    return obj


def render_views(out_dir: Path) -> None:
    scene = bpy.context.scene
    engines = bpy.context.scene.render.bl_rna.properties["engine"].enum_items.keys()
    if "BLENDER_EEVEE_NEXT" in engines:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    elif "BLENDER_EEVEE" in engines:
        scene.render.engine = "BLENDER_EEVEE"
    else:
        scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1000
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    eevee = getattr(scene, "eevee", None)
    if eevee is not None:
        if hasattr(eevee, "use_ssr"):
            eevee.use_ssr = True
            eevee.use_ssr_refraction = True
        if hasattr(eevee, "taa_render_samples"):
            eevee.taa_render_samples = 32

    views = {
        "front": ((0.0, 0.0, 220.0), (0.0, 0.0, 0.0), 160.0),
        "side": ((220.0, 0.0, -70.0), (90.0, 0.0, 90.0), 180.0),
        "top": ((0.0, 220.0, -70.0), (0.0, 0.0, 0.0), 180.0),
        "three_quarter": ((110.0, 35.0, 150.0), (75.0, 0.0, 36.0), 170.0),
    }
    # Front: camera looks -Z from +Z. Rotation (0,0,0) is correct for default cam.
    # Side: from +X looking at origin. Default cam looks -Z, so rotate 90° around Y? 
    # Blender camera default: loc (0,0,0) rot (90,0,0) looks -Y in some versions...
    # Default camera rotation is (1.3708, 0, 0.8) looking at scene.
    # For ORTHO:
    #   front: location (0,0,200), rotation (0,0,0) — looks down local -Z toward origin if we rotate.
    # Standard: rotation_euler (90°, 0, 0) looks -Y. We want look -Z for front? 
    # Camera local -Z is view direction.
    # rotation (0,0,0): local -Z = world -Z, so camera at +Z looking at origin. GOOD for front.
    # side from +X: camera at (200,0,-70), need local -Z = world -X → rotate +90° around Y.
    #   Euler XYZ: (0, 90°, 0)
    # top from +Y: camera at (0,200,-70), local -Z = world -Y → rotate +90° around X.
    #   Euler XYZ: (90°, 0, 0)

    views = {
        "front": (Vector((0.0, 0.0, 220.0)), (0.0, 0.0, 0.0), 155.0),
        "side": (Vector((220.0, 8.0, -70.0)), (0.0, 90.0, 0.0), 190.0),
        "top": (Vector((0.0, 220.0, -68.0)), (-90.0, 0.0, 0.0), 230.0),
        "three_quarter": (Vector((95.0, 40.0, 145.0)), (12.0, 32.0, 0.0), 165.0),
    }
    # Three-quarter: approximate look-at origin from +X+Z.
    # Easier: use track-to.
    for name, (loc, rot, scale) in views.items():
        cam = add_camera(f"cam_{name}", loc, rot, scale)
        if name == "three_quarter":
            con = cam.constraints.new("TRACK_TO")
            # empty at origin
            if "look_at" not in bpy.data.objects:
                empty = bpy.data.objects.new("look_at", None)
                empty.location = (0, 0, -40)
                bpy.context.collection.objects.link(empty)
            con.target = bpy.data.objects["look_at"]
            con.track_axis = "TRACK_NEGATIVE_Z"
            con.up_axis = "UP_Y"
        scene.camera = cam
        scene.render.filepath = str(out_dir / f"validate_{name}.png")
        bpy.ops.render.render(write_still=True)
    # Frame-only front silhouette for photo overlay.
    for obj in bpy.data.objects:
        if "lens" in obj.name.lower():
            obj.hide_render = True
    scene.camera = bpy.data.objects["cam_front"]
    scene.render.filepath = str(out_dir / "validate_front_frame.png")
    bpy.ops.render.render(write_still=True)
    for obj in bpy.data.objects:
        obj.hide_render = False


def overlay_front(out_dir: Path) -> None:
    """Composite the front render onto the official front photo for silhouette check."""
    try:
        from PIL import Image
    except ImportError:
        return
    photo = Image.open(FRONT_PHOTO).convert("RGBA")
    render = Image.open(out_dir / "validate_front.png").convert("RGBA")
    # Photo is 4160. Inner A = 49 mm = 1256 px from measure script.
    # Render ortho_scale 155 mm across 1600 px → 1600/155 px/mm
    # We'll scale render so 155 mm = the same mm as the photo.
    # Photo px/mm ≈ 25.6327 from measure_front.py
    px_per_mm_photo = 25.6327
    px_per_mm_render = 1600 / 155.0
    scale = px_per_mm_photo / px_per_mm_render
    new_w = int(render.width * scale)
    new_h = int(render.height * scale)
    render = render.resize((new_w, new_h), Image.Resampling.LANCZOS)
    canvas = photo.copy()
    # Center of photo is the frame center (image is square, glasses centered).
    x = (photo.width - new_w) // 2
    y = (photo.height - new_h) // 2
    canvas.alpha_composite(render, (x, y))
    canvas.convert("RGB").save(out_dir / "overlay_front.jpg", quality=92)


def export_files(frame: bpy.types.Object, lens: bpy.types.Object) -> None:
    EXPORT.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    frame.select_set(True)
    lens.select_set(True)
    bpy.context.view_layer.objects.active = frame

    blend_path = EXPORT / "QL2009_C1.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    fbx_path = EXPORT / "QL2009_C1.fbx"
    bpy.ops.export_scene.fbx(
        filepath=str(fbx_path),
        use_selection=True,
        object_types={"MESH"},
        use_mesh_modifiers=True,
        mesh_smooth_type="FACE",
        add_leaf_bones=False,
        bake_space_transform=True,
        axis_forward="-Z",
        axis_up="Y",
        apply_scale_options="FBX_SCALE_ALL",
        path_mode="COPY",
        embed_textures=False,
    )

    glb_path = EXPORT / "QL2009_C1.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )


def write_report(frame: bpy.types.Object, lens: bpy.types.Object, inner: list[Vector]) -> None:
    xs = [p.x for p in inner]
    ys = [p.y for p in inner]
    report = {
        "sku": "QL2009 C1",
        "method": "manual Blender hard-surface from official front photo trace + Mirror",
        "triangle_count": {
            "frame": count_tris(frame),
            "lenses": count_tris(lens),
            "total": count_tris(frame) + count_tris(lens),
        },
        "dimensions_mm": {
            "frame": bounds_mm(frame),
            "lenses": bounds_mm(lens),
        },
        "locked_from_photo": {
            "A_lens_width_mm": A_MM,
            "inner_lens_height_mm": round(max(ys) - min(ys), 2),
            "right_inner_x_min": round(min(xs), 2),
            "right_inner_x_max": round(max(xs), 2),
            "photo_inner_gap_at_mid_mm": round(min(xs) * 2, 2),
            "stamp_DBL_mm": DBL_STAMP_MM,
            "temple_length_mm": TEMPLE_LEN_MM,
            "rim_width_mm_from_photo_6oclock": 1.44,
        },
        "materials": {
            "frame": {
                "name": "QL2009_Ultem_MatteBlack",
                "base_color": FRAME_COLOR[:3],
                "roughness": FRAME_ROUGH,
                "metallic": 0.0,
            },
            "lens": {
                "name": "QL2009_Lens_Clear",
                "ior": LENS_IOR,
                "transmission": 1.0,
                "factory_markings": False,
            },
        },
        "assumptions": {
            "rim_depth_mm": RIM_DEPTH_MM,
            "rim_width_used_mm": RIM_WIDTH_MM,
            "front_wrap_deg_per_side": WRAP_DEG,
            "lens_sagitta_mm": LENS_SAGITTA_MM,
            "lens_thickness_mm": LENS_THICK_MM,
            "temple_cross_section_hinge_mm": [TEMPLE_W0, TEMPLE_H0],
            "ear_drop_mm": EAR_DROP_MM,
            "temple_inset_mm": TEMPLE_INSET_MM,
            "nose_pads": "omitted — visible on photo (clear pads + metal arms) but 3D path cannot be reconstructed reliably; not invented",
            "hinge_mechanics": "flush lug only; no screws / spring barrel",
            "face_form": "near-flat; WRAP_DEG is an assumption",
        },
        "needs_verification": [
            "rim front-to-back depth (no top photo)",
            "temple cross-section (round vs flat)",
            "ear-bend start in mm",
            "exact hinge hardware",
            "nose-pad arm path if pads are required later",
            "stamp DBL 18 mm vs photo mid-gap ~22 mm — silhouette follows the photo",
        ],
        "export": {
            "blend": str(EXPORT / "QL2009_C1.blend"),
            "fbx": str(EXPORT / "QL2009_C1.fbx"),
            "glb": str(EXPORT / "QL2009_C1.glb"),
        },
        "origin": "geometric center of the front; +Y up; front faces +Z; temples travel -Z",
        "scale": "1 Blender unit = 1 mm",
    }
    EXPORT.mkdir(parents=True, exist_ok=True)
    (EXPORT / "QL2009_C1_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


def main() -> None:
    setup_units()
    clear_scene()
    setup_world()

    inner = load_right_inner()
    frame_mat, lens_mat = make_materials()

    rim, inner_raw, center = build_right_rim(inner)
    bridge = build_half_bridge(inner)
    temple = build_right_temple(center, inner)
    lens_r = build_right_lens(inner)

    assign_mat(rim, frame_mat)
    assign_mat(bridge, frame_mat)
    assign_mat(temple, frame_mat)
    assign_mat(lens_r, lens_mat)

    frame = join_objects("QL2009_C1_Frame", [rim, bridge, temple])
    apply_mirror(frame)
    shade_smooth(frame)

    apply_mirror(lens_r)
    lens_r.name = "QL2009_C1_Lenses"
    shade_smooth(lens_r)

    # Origin at geometric center, already ~0. Place wear origin near bridge.
    for obj in (frame, lens_r):
        obj.location = (0.0, 0.0, 0.0)

    write_report(frame, lens_r, inner)
    render_views(EXPORT)
    overlay_front(EXPORT)
    export_files(frame, lens_r)
    print("DONE", EXPORT)


if __name__ == "__main__":
    main()
