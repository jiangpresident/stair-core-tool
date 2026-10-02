"""Editable floor-plan candidates using local image processing only.

This is a heuristic baseline, not a trained semantic model.  Orthogonal line
bands suggest walls; repeated equally spaced strokes suggest stair treads;
quarter-circle support near straight door leaves suggests door openings.
Coordinates always refer to the original image, after EXIF orientation.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps


@dataclass
class Line:
    axis: str
    c: float
    a: float
    b: float
    thickness: float = 1.0

    @property
    def length(self) -> float:
        return self.b - self.a


def _number(options, name, default, lo, hi):
    try:
        value = float(options.get(name, default))
    except (TypeError, ValueError, OverflowError):
        value = default
    return max(lo, min(hi, value)) if math.isfinite(value) else default


def _extract_lines(mask: np.ndarray, min_length: int) -> list[Line]:
    """Opening preserves axis strokes; connected boxes collapse stroke width."""
    lines = []
    for axis in ("h", "v"):
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT,
                    (min_length, 1) if axis == "h" else (1, min_length))
        opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        count, _, stats, _ = cv2.connectedComponentsWithStats(opened, 8)
        for x, y, w, h, area in stats[1:count]:
            length, thickness = (w, h) if axis == "h" else (h, w)
            if length < min_length or thickness > max(16, length * .36):
                continue
            if axis == "h":
                lines.append(Line(axis, y + (h - 1) / 2, x, x + w - 1, h))
            else:
                lines.append(Line(axis, x + (w - 1) / 2, y, y + h - 1, w))
    return lines


def _overlap(a, b, c, d):
    return max(0., min(b, d) - max(a, c))


def _stairs(lines: list[Line], width: int, height: int):
    """Find runs of at least six similarly sized, regularly spaced strokes."""
    groups = []
    used = set()
    for axis in ("h", "v"):
        indexes = sorted((i for i, l in enumerate(lines) if l.axis == axis
                          and 14 <= l.length <= max(width, height) * .35),
                         key=lambda i: lines[i].c)
        for i in indexes:
            if i in used:
                continue
            seed = lines[i]
            tol = max(3, min(7, seed.length * .08))
            similar = [j for j in indexes if abs(lines[j].a - seed.a) <= tol
                       and abs(lines[j].b - seed.b) <= tol]
            # Separate distant flights with matching stroke lengths.
            runs, run = [], []
            for j in similar:
                if run and lines[j].c - lines[run[-1]].c > 35:
                    runs.append(run)
                    run = []
                run.append(j)
            runs.append(run)
            for run in runs:
                if i not in run or len(run) < 6:
                    continue
                cs = np.array([lines[j].c for j in run])
                gaps = np.diff(cs)
                spacing = float(np.median(gaps))
                if not 3 <= spacing <= 32 or np.mean(abs(gaps-spacing) <= max(2, spacing*.3)) < .78:
                    continue
                if cs[-1] - cs[0] < 25:
                    continue
                a = float(np.median([lines[j].a for j in run]))
                b = float(np.median([lines[j].b for j in run]))
                if axis == "h":
                    box = [a, cs[0], b, cs[-1]]
                else:
                    box = [cs[0], a, cs[-1], b]
                groups.append({"core": box, "indexes": set(run), "count": len(run),
                               "spacing": spacing, "axis": axis})
                used.update(run)
    # A split flight often has a narrow center railing breaking every tread.
    merged = []
    for group in groups:
        found = None
        for other in merged:
            if other["axis"] != group["axis"]:
                continue
            a, b = other["core"], group["core"]
            xgap = max(a[0] - b[2], b[0] - a[2], 0)
            ygap = max(a[1] - b[3], b[1] - a[3], 0)
            if (xgap <= 14 and _overlap(a[1],a[3],b[1],b[3]) > min(a[3]-a[1],b[3]-b[1])*.6) or \
               (ygap <= 14 and _overlap(a[0],a[2],b[0],b[2]) > min(a[2]-a[0],b[2]-b[0])*.6):
                found = other
                break
        if found:
            a,b=found["core"],group["core"]
            found["core"]=[min(a[0],b[0]),min(a[1],b[1]),max(a[2],b[2]),max(a[3],b[3])]
            found["indexes"].update(group["indexes"])
            found["count"] += group["count"]
        else:
            merged.append(group)
    for group in merged:
        x1,y1,x2,y2=group["core"]
        # Look for long side boundaries to include platforms.  We do not claim
        # to infer a code-defined stair enclosure from geometry alone.
        if group["axis"] == "h":
            side1=[l for l in lines if l.axis=="v" and x1-65 <= l.c <= x1+3
                   and l.a<=y1+3 and l.b>=y2-3 and l.length > (y2-y1)*1.18]
            side2=[l for l in lines if l.axis=="v" and x2-3 <= l.c <= x2+65
                   and l.a<=y1+3 and l.b>=y2-3 and l.length > (y2-y1)*1.18]
        else:
            side1=[l for l in lines if l.axis=="h" and y1-65 <= l.c <= y1+3
                   and l.a<=x1+3 and l.b>=x2-3 and l.length > (x2-x1)*1.18]
            side2=[l for l in lines if l.axis=="h" and y2-3 <= l.c <= y2+65
                   and l.a<=x1+3 and l.b>=x2-3 and l.length > (x2-x1)*1.18]
        if side1 and side2:
            target1,target2=(x1,x2) if group["axis"]=="h" else (y1,y2)
            a=min(side1,key=lambda l:abs(l.c-target1))
            b=min(side2,key=lambda l:abs(l.c-target2))
            lo=max(a.a,b.a)
            hi=min(a.b,b.b)
            if group["axis"]=="h" and hi-lo < max(600,(y2-y1)*4):
                x1,x2,y1,y2=a.c,b.c,min(y1,lo),max(y2,hi)
            elif group["axis"]=="v" and hi-lo < max(600,(x2-x1)*4):
                y1,y2,x1,x2=a.c,b.c,min(x1,lo),max(x2,hi)
        group["box"]=[max(0,x1),max(0,y1),min(width-1,x2),min(height-1,y2)]
    return merged, used


def _arc_support(distance, hx, hy, radius, sx, sy):
    # Exclude the ends, which can be explained by the leaf/wall alone.
    angles=np.linspace(.13,math.pi/2-.13,52)
    xx=np.rint(hx+sx*radius*np.cos(angles)).astype(int)
    yy=np.rint(hy+sy*radius*np.sin(angles)).astype(int)
    h,w=distance.shape
    if min(xx)<0 or min(yy)<0 or max(xx)>=w or max(yy)>=h:
        return 0.,0.
    values=distance[yy,xx]
    support=float(np.mean(values<=1.65))
    # Arc support must be distributed, not just one coincident nearby object.
    sections=[float(np.mean(v<=1.9)) for v in np.array_split(values,4)]
    spread=sum(s>.18 for s in sections)/4
    return support,spread


def _doors(mask, lines, stair_groups, sensitivity):
    # Remove axis strokes before testing the curved part of a swing symbol.
    axis=np.zeros_like(mask)
    # Adapt to raster stroke thickness: upscaled drawings need longer kernels
    # so the shallow parts of a thick circular arc are not erased as lines.
    stroke=float(np.percentile([l.thickness for l in lines],75)) if lines else 1.
    straight_length=max(9,min(29,round(stroke*4)))
    for size in ((straight_length,1),(1,straight_length)):
        axis=cv2.bitwise_or(axis,cv2.morphologyEx(mask,cv2.MORPH_OPEN,
              cv2.getStructuringElement(cv2.MORPH_RECT,size)))
    curved=cv2.bitwise_and(mask,cv2.bitwise_not(axis))
    # Elevator crosses, diagonal furniture and dimension leaders can partially
    # coincide with a circle. Remove long straight diagonals from arc evidence.
    diagonals=cv2.HoughLinesP(mask,1,np.pi/180,threshold=20,
                              minLineLength=max(23,min(80,round(stroke*10))),maxLineGap=2)
    if diagonals is not None:
        for x1,y1,x2,y2 in diagonals[:,0]:
            dx,dy=abs(int(x2)-int(x1)),abs(int(y2)-int(y1))
            if min(dx,dy)>5 and min(dx,dy)/max(dx,dy)>.12:
                cv2.line(curved,(x1,y1),(x2,y2),0,3)
    distance=cv2.distanceTransform(255-curved,cv2.DIST_L2,3)
    candidates=[]
    max_radius=max(30,min(175,max(mask.shape)*.14))
    min_score=.49-.14*sensitivity
    for leaf in lines:
        if not 13<=leaf.length<=max_radius*2 or leaf.thickness>6:
            continue
        # Stair/railing lines generate many false arc hypotheses.
        lx,ly=((leaf.a+leaf.b)/2,leaf.c) if leaf.axis=="h" else (leaf.c,(leaf.a+leaf.b)/2)
        if any(g["box"][0]-2<=lx<=g["box"][2]+2 and
               g["box"][1]-2<=ly<=g["box"][3]+2 for g in stair_groups):
            continue
        hinges=[leaf.a,leaf.b]
        for wall in lines:
            if wall.axis==leaf.axis or wall.length<23:
                continue
            if leaf.a+5<wall.c<leaf.b-5 and min(abs(wall.a-leaf.c),abs(wall.b-leaf.c))<=6:
                hinges.append(wall.c)
        for hinge in hinges:
            for tip in (leaf.a,leaf.b):
                full_radius=abs(tip-hinge)
                if full_radius<13:
                    continue
                direction=1 if tip>hinge else -1
                # A leaf can be collinear with a stall partition, making the
                # connected stroke longer than the leaf. Search shorter arcs.
                radii=[full_radius] if full_radius<=max_radius else []
                if full_radius>=36:
                    radii+=list(range(18,int(min(max_radius,full_radius-7))+1,3))
                for swing in (-1,1):
                    hx,hy=(hinge,leaf.c) if leaf.axis=="h" else (leaf.c,hinge)
                    sx,sy=(direction,swing) if leaf.axis=="h" else (swing,direction)
                    # Double-line leaves shift the inferred radius a few pixels.
                    best=(0.,0.,full_radius)
                    for radius in radii:
                        for rr in (radius-1,radius,radius+1):
                            score,spread=_arc_support(distance,hx,hy,rr,sx,sy)
                            if score>best[0]: best=(score,spread,rr)
                    score,spread,rr=best
                    cutoff=max(min_score,.5-.08*sensitivity) if rr<full_radius-5 else min_score
                    if score<cutoff or spread<.75:
                        continue
                    # Opening has to be predominantly clear, not a solid wall.
                    q=np.linspace(.15,.85,24)*rr*swing
                    xx=np.rint(np.full(24,hx) if leaf.axis=="h" else hx+q).astype(int)
                    yy=np.rint(hy+q if leaf.axis=="h" else np.full(24,hy)).astype(int)
                    if min(xx)<0 or min(yy)<0 or max(xx)>=mask.shape[1] or max(yy)>=mask.shape[0]:
                        continue
                    clear_test=np.zeros(24,dtype=bool)
                    for offset in range(-2,3):
                        px=xx+offset if leaf.axis=="h" else xx
                        py=yy if leaf.axis=="h" else yy+offset
                        px=np.clip(px,0,mask.shape[1]-1)
                        py=np.clip(py,0,mask.shape[0]-1)
                        clear_test |= mask[py,px]>0
                    if np.mean(clear_test)>.60:
                        continue
                    opening=Line("v" if leaf.axis=="h" else "h",hinge,
                        min(leaf.c,leaf.c+swing*rr),max(leaf.c,leaf.c+swing*rr))
                    short_leaf=Line(leaf.axis,leaf.c,min(hinge,hinge+direction*rr),max(hinge,hinge+direction*rr))
                    candidates.append({"line":opening,"score":score,"leaf":short_leaf,
                                       "hinge":(hx,hy),"radius":rr})
    # Same swing drawn with two leaf edges should produce one door candidate.
    candidates.sort(key=lambda d:d["score"],reverse=True)
    kept=[]
    for door in candidates:
        a=door["line"]
        if any(a.axis==b["line"].axis and abs(a.c-b["line"].c)<9 and
               _overlap(a.a,a.b,b["line"].a,b["line"].b) > min(a.length,b["line"].length)*.62
               for b in kept):
            continue
        kept.append(door)
    return kept


def _merge_walls(lines, doors, stairs, min_length, bridge_gap, shape):
    max_thickness=max(8,min(24,max(shape)*.025))
    viable=[]
    for l in lines:
        if l.length<min_length:
            continue
        # Remove regularly repeated treads and internal rails, even if a line
        # index changed. The rectangle border remains available for walls.
        is_tread=False
        for stair in stairs:
            x1,y1,x2,y2=stair["core"]
            if l.axis=="h" and y1+2<l.c<y2-2 and l.a>=x1-3 and l.b<=x2+3:
                is_tread=True
            if l.axis=="v" and x1+2<l.c<x2-2 and l.a>=y1-3 and l.b<=y2+3:
                is_tread=True
            bx1,by1,bx2,by2=stair["box"]
            if l.axis=="h" and by1+3<l.c<by2-3 and l.a>=bx1-2 and l.b<=bx2+2:
                is_tread=True
            if l.axis=="v" and bx1+3<l.c<bx2-3 and l.a>=by1-2 and l.b<=by2+2:
                is_tread=True
            if stair["axis"]==l.axis:
                if l.axis=="h" and y1-1<=l.c<=y2+1 and l.a>=x1-3 and l.b<=x2+3:
                    is_tread=True
                if l.axis=="v" and x1-1<=l.c<=x2+1 and l.a>=y1-3 and l.b<=y2+3:
                    is_tread=True
        if is_tread:
            continue
        # A door leaf can be collinear with a longer partition. Subtract only
        # the supported leaf extent, retaining the structural part of the line.
        pieces=[(l.a,l.b)]
        for door in doors:
            leaf=door["leaf"]
            if l.axis!=leaf.axis or abs(l.c-leaf.c)>3.1:
                continue
            next_pieces=[]
            for a,b in pieces:
                if _overlap(a,b,leaf.a,leaf.b)<7:
                    next_pieces.append((a,b))
                else:
                    if leaf.a-a>=8:next_pieces.append((a,leaf.a))
                    if b-leaf.b>=8:next_pieces.append((leaf.b,b))
            pieces=next_pieces
        viable.extend(Line(l.axis,l.c,a,b,l.thickness) for a,b in pieces
                      if b-a>=max(12,min_length*.55))
    clusters=[]
    for l in sorted(viable,key=lambda x:(x.axis,x.c,-x.length)):
        fits=[]
        for i,g in enumerate(clusters):
            if l.axis!=g[0].axis:
                continue
            coords=[v.c for v in g]+[l.c]
            if max(coords)-min(coords)>max_thickness:
                continue
            if any(_overlap(l.a,l.b,v.a,v.b)>min(18,min(l.length,v.length)*.3)
                   or (abs(l.c-v.c)<2.5 and max(l.a-v.b,v.a-l.b)<=bridge_gap)
                   for v in g):
                fits.append(i)
        if fits:
            # Avoid transitive grouping across unrelated nearby partitions.
            clusters[fits[0]].append(l)
        else:
            clusters.append([l])
    # Snap at most once. Repeated snapping could drift a door through several
    # nearby wall bands. Use only a band adjacent to the opening endpoints.
    for door in doors:
        d=door["line"]
        fits=[]
        for group in clusters:
            if group[0].axis!=d.axis:continue
            cs=[l.c for l in group]
            c=(min(cs)+max(cs))/2
            if abs(c-d.c)>max_thickness*.65:continue
            end_dist=min(min(abs(d.a-l.b),abs(d.b-l.a)) for l in group)
            if end_dist<=max_thickness:
                fits.append((abs(c-d.c)+end_dist*.2,c))
        if fits:d.c=min(fits)[1]
    walls=[]
    for group in clusters:
        cs=[l.c for l in group]
        c=(min(cs)+max(cs))/2
        axis=group[0].axis
        intervals=[]
        for l in sorted(group,key=lambda x:x.a):
            if intervals and l.a<=intervals[-1][1]+bridge_gap:
                intervals[-1][1]=max(intervals[-1][1],l.b)
            else:
                intervals.append([l.a,l.b])
        # All recognised openings cut the wall layer, even after gap bridging.
        for door in doors:
            d=door["line"]
            if d.axis!=axis or abs(d.c-c)>max_thickness:
                continue
            new=[]
            for a,b in intervals:
                if d.b<=a or d.a>=b:
                    new.append([a,b])
                else:
                    if d.a>a+3:new.append([a,d.a])
                    if d.b<b-3:new.append([d.b,b])
            intervals=new
        for a,b in intervals:
            if b-a>=max(8,min_length*.45):
                walls.append((Line(axis,c,a,b),.72 if len(group)>1 else .52))
    return walls


def detect(image: Image.Image, options: dict | None = None) -> dict[str,Any]:
    """Return editable walls, doors and stair polygons in ORIGINAL pixels.

    Options: threshold (0..255, default 180), min_wall_length (original pixels,
    default 35), bridge_gap (original pixels, default 12), sensitivity (0..1).
    Confidence values are heuristic scores, NOT calibrated probabilities.
    """
    options=options or {}
    image=ImageOps.exif_transpose(image)
    if image.mode in ("RGBA","LA") or "transparency" in image.info:
        rgba=image.convert("RGBA")
        background=Image.new("RGBA",rgba.size,"white")
        background.alpha_composite(rgba)
        image=background.convert("RGB")
    width,height=image.size
    if width<8 or height<8:
        raise ValueError("Image is too small; use at least 8 × 8 pixels.")
    threshold=_number(options,"threshold",180,1,254)
    requested_min=_number(options,"min_wall_length",35,5,10000)
    requested_gap=_number(options,"bridge_gap",12,0,1000)
    sensitivity=_number(options,"sensitivity",.5,0,1)
    scale=min(1.,1400/max(width,height))
    work=image.convert("L")
    if scale<1:
        work=work.resize((max(1,round(width*scale)),max(1,round(height*scale))),Image.Resampling.LANCZOS)
    gray=np.asarray(work)
    mask=np.where(gray<=threshold,255,0).astype(np.uint8)
    min_length=max(12,round(requested_min*scale))
    gap=max(0,requested_gap*scale)
    all_lines=_extract_lines(mask, max(8,round(8*scale)))
    stair_groups,_=_stairs(all_lines,gray.shape[1],gray.shape[0])
    doors=_doors(mask,all_lines,stair_groups,sensitivity)
    walls=_merge_walls(all_lines,doors,stair_groups,min_length,gap,gray.shape)
    # Opposing swing symbols can converge to the same opening after snapping.
    unique_doors=[]
    for door in doors:
        a=door["line"]
        if any(a.axis==d["line"].axis and abs(a.c-d["line"].c)<7 and
               _overlap(a.a,a.b,d["line"].a,d["line"].b)>min(a.length,d["line"].length)*.65
               for d in unique_doors):continue
        unique_doors.append(door)
    doors=[d for d in unique_doors if not any(
        d is not other and d["line"].axis==other["line"].axis and
        d["line"].length < other["line"].length*.6 and
        abs(d["line"].c-other["line"].c)<other["line"].length*.65 and
        _overlap(d["line"].a,d["line"].b,other["line"].a,other["line"].b)>d["line"].length*.7
        for other in unique_doors)]
    inv=1/scale
    def point(x,y):
        return [round(max(0,min(width-1,x*inv)),2),round(max(0,min(height-1,y*inv)),2)]
    def segment(l,kind,index,confidence):
        p1,p2=(point(l.a,l.c),point(l.b,l.c)) if l.axis=="h" else (point(l.c,l.a),point(l.c,l.b))
        return {"id":f"{kind}-{index+1}","x1":p1[0],"y1":p1[1],"x2":p2[0],"y2":p2[1],
                "source":"auto","confidence":round(confidence,3)}
    result={"walls":[segment(l,"wall",i,s) for i,(l,s) in enumerate(walls)],
            "doors":[segment(d["line"],"door",i,min(.92,.48+d["score"]*.45)) for i,d in enumerate(doors)],
            "stairs":[],"meta":{}}
    for i,g in enumerate(stair_groups):
        x1,y1,x2,y2=g["box"]
        result["stairs"].append({"id":f"stair-{i+1}","points":[point(x1,y1),point(x2,y1),point(x2,y2),point(x1,y2)],
              "source":"auto","confidence":round(min(.9,.55+.015*g["count"]),3)})
    warnings=["本地几何规则生成候选标注；未使用训练模型，置信分数不代表实测准确率。",
              "请重点核对小门、无开启圆弧的门、斜墙、家具线条，以及楼梯间和平台边界。窗线只在能够与墙线连接时合并。"]
    if not result["walls"]:warnings.append("未找到足够长的墙线；可调高二值化阈值或降低最短墙线长度，或手动绘制。")
    if not result["doors"]:warnings.append("未找到可靠的门扇开启圆弧；请手动添加门洞线。")
    if not result["stairs"]:warnings.append("未找到规则排列的楼梯踏步；请手动画出楼梯间范围。")
    result["meta"]={"engine":"local-opencv-heuristics-v1","warnings":warnings,
                    "width":width,"height":height,"working_width":gray.shape[1],"working_height":gray.shape[0],
                    "scale":scale,"options":{"threshold":threshold,"min_wall_length":requested_min,
                    "bridge_gap":requested_gap,"sensitivity":sensitivity},
                    "confidence_note":"Heuristic ranking scores; not calibrated probabilities or measured accuracy."}
    return result
