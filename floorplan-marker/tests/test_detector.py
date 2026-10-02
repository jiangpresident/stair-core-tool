"""Behavioral fixtures for the heuristic detector; no claim of field accuracy."""
import math
import unittest

from PIL import Image, ImageDraw

from detector import detect


def clean_plan(scale=1):
    im=Image.new("RGB",(500,380),"white")
    d=ImageDraw.Draw(im)
    # Double-line enclosure and a partition with a genuine 50px door opening.
    d.rectangle((40,40,460,340),outline="black",width=2)
    d.rectangle((50,50,450,330),outline="black",width=2)
    for x in (245,255):
        d.line((x,50,x,170),fill="black",width=2)
        d.line((x,220,x,330),fill="black",width=2)
    d.line((200,170,250,170),fill="black",width=2)
    d.arc((200,120,300,220),90,180,fill="black",width=1)
    # The window remains a thin parallel-line symbol in a break in the wall.
    d.rectangle((39,130,51,180),fill="white")
    for x in (42,48):d.line((x,130,x,180),fill=(130,130,130),width=1)
    # Stair flight with landings, in an enclosing rectangle.
    d.rectangle((320,80,420,240),outline=(120,120,120))
    for y in range(110,201,10):d.line((320,y,420,y),fill=(120,120,120))
    # Long diagonal elevator/furniture crosses should not become swing doors.
    d.rectangle((90,220,160,300),outline="black")
    d.line((90,220,160,300),fill="black")
    d.line((90,300,160,220),fill="black")
    return im if scale==1 else im.resize((500*scale,380*scale),Image.Resampling.NEAREST)


class DetectorTests(unittest.TestCase):
    def test_blank_and_transparent_images_have_no_candidates(self):
        for im in (Image.new("RGB",(200,160),"white"),Image.new("RGBA",(200,160),(0,0,0,0))):
            result=detect(im)
            self.assertEqual({k:len(result[k]) for k in ("walls","doors","stairs")},
                             {"walls":0,"doors":0,"stairs":0})
            self.assertGreater(len(result["meta"]["warnings"]),2)

    def test_window_connects_wall_and_door_stays_open(self):
        result=detect(clean_plan())
        # A continuous left-wall centerline crosses the thin gray window.
        self.assertTrue(any(abs(w["x1"]-45)<6 and abs(w["x2"]-45)<6
                            and w["y1"]<=130 and w["y2"]>=180 for w in result["walls"]))
        door=[d for d in result["doors"] if abs(d["x1"]-250)<10
              and abs(d["x2"]-250)<10 and abs(d["y1"]-170)<7 and abs(d["y2"]-220)<7]
        self.assertTrue(door,"Quarter-circle symbol should yield a vertical opening.")
        self.assertFalse(any(abs(w["x1"]-250)<10 and abs(w["x2"]-250)<10
                             and w["y1"]<185 and w["y2"]>205 for w in result["walls"]),
                         "Wall must not cover the detected door opening.")

    def test_stair_region_includes_platforms_and_not_treads_as_walls(self):
        result=detect(clean_plan())
        self.assertEqual(len(result["stairs"]),1)
        pts=result["stairs"][0]["points"]
        self.assertLessEqual(min(p[1] for p in pts),85)
        self.assertGreaterEqual(max(p[1] for p in pts),235)
        self.assertFalse(any(330<w["x1"]<410 and 330<w["x2"]<410
                             and 120<w["y1"]<190 and 120<w["y2"]<190
                             for w in result["walls"]))

    def test_straight_diagonal_cross_is_not_a_swing_arc(self):
        result=detect(clean_plan())
        self.assertFalse(any(80<d["x1"]<170 and 80<d["x2"]<170
                             and 210<d["y1"]<310 and 210<d["y2"]<310
                             for d in result["doors"]))

    def test_output_is_original_pixel_coordinates_after_downscale(self):
        result=detect(clean_plan(4),{"min_wall_length":140,"bridge_gap":48})
        self.assertEqual((result["meta"]["width"],result["meta"]["height"]),(2000,1520))
        self.assertLess(result["meta"]["scale"],1)
        # The enclosing right wall is near x=455*4, not working-image x=1274.
        self.assertTrue(any(abs(w["x1"]-1820)<30 and w["y2"]>1250
                            for w in result["walls"]))
        self.assertEqual(len(result["stairs"]),1)
        self.assertTrue(any(abs(d["x1"]-1000)<30 and abs(d["y1"]-680)<30
                            and abs(d["y2"]-880)<30 for d in result["doors"]))
        ids=[]
        for category in ("walls","doors","stairs"):
            for feature in result[category]:
                ids.append(feature["id"])
                points=feature.get("points",[[feature.get("x1"),feature.get("y1")],
                                              [feature.get("x2"),feature.get("y2")]])
                for x,y in points:
                    self.assertTrue(math.isfinite(x) and math.isfinite(y))
                    self.assertTrue(0<=x<2000 and 0<=y<1520)
        self.assertEqual(len(ids),len(set(ids)))

    def test_extreme_aspect_ratio_and_option_numbers_do_not_crash(self):
        result=detect(Image.new("RGB",(20000,8),"white"),{"threshold":10**500})
        self.assertEqual(result["meta"]["working_height"],1)
        self.assertEqual(result["walls"],[])
        with self.assertRaises(ValueError):detect(Image.new("RGB",(7,7),"white"))


if __name__=="__main__":unittest.main()
