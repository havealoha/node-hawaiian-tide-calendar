#!/usr/bin/env python3
import os
import sys
import json
import ctypes
import math

class TIDE_STATION_HEADER(ctypes.Structure):
    _fields_ = [
        ("record_number", ctypes.c_int32),     # 4 bytes
        ("record_size", ctypes.c_uint32),      # 4 bytes (Doc says uint32)
        ("record_type", ctypes.c_uint8),       # 1 byte  (Doc says uint8)
        ("latitude", ctypes.c_double),         # 8 bytes
        ("longitude", ctypes.c_double),        # 8 bytes
        ("reference_station", ctypes.c_int32), # 4 bytes
        ("tzfile", ctypes.c_int16),            # 2 bytes (Doc says int16)
        ("name", ctypes.c_char * 90),          # Doc says 90 chars
    ]

lib = ctypes.CDLL("/usr/lib64/libtcd.so")

lib.open_tide_db.argtypes = [ctypes.c_char_p]
lib.open_tide_db.restype = ctypes.c_int

lib.close_tide_db.argtypes = []
lib.close_tide_db.restype = None

lib.get_nearest_partial_tide_record.argtypes = [
    ctypes.c_double, ctypes.c_double, ctypes.POINTER(TIDE_STATION_HEADER)
]
lib.get_nearest_partial_tide_record.restype = ctypes.c_int

def haversine(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def main():
    if len(sys.argv) != 3:
        print(json.dumps({"error": "need lat lon"}), file=sys.stderr)
        sys.exit(1)

    try:
        lat = float(sys.argv[1])
        lon = float(sys.argv[2])
    except ValueError:
        print(json.dumps({"error": "lat lon must be numbers"}), file=sys.stderr)
        sys.exit(1)

    hfile = os.environ.get("HFILE_PATH", "")
    if not hfile:
        print(json.dumps({"error": "HFILE_PATH not set"}), file=sys.stderr)
        sys.exit(1)

    results = []
    header = TIDE_STATION_HEADER()
    header_ptr = ctypes.pointer(header)

    for path in hfile.split(":"):
        path = os.path.expanduser(path.strip())
        if not os.path.isfile(path):
            continue

        if lib.open_tide_db(path.encode()) == 0:
            print("Failed to open database", file=sys.stderr)
            continue

        index = lib.get_nearest_partial_tide_record(lat, lon, header_ptr)

        if index >= 0:
            name = header.name.decode('utf-8', errors='replace').strip()

            slat = header.latitude
            slon = header.longitude
            dist = haversine(lat, lon, slat, slon)

            results.append({
                "name": name,
                "lat": round(slat, 6),
                "lon": round(slon, 6),
                "dist": round(dist, 1),
                "file": os.path.basename(path)
            })

        lib.close_tide_db()

    results.sort(key=lambda x: x["dist"])
    print(json.dumps(results[:10] if results else []))

if __name__ == "__main__":
    main()
