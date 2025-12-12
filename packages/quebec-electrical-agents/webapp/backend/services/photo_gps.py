"""
Photo GPS Service - Extract GPS coordinates from photos and map to electrical plans

This service:
- Extracts EXIF data from photos taken on-site
- Reads GPS coordinates (latitude, longitude, altitude)
- Maps photo locations to positions on electrical floor plans
- Supports georeferencing of electrical plans
"""

from PIL import Image
from PIL.ExifTags import TAGS, GPSTAGS
import piexif
from typing import Dict, Optional, Tuple, List
from pydantic import BaseModel, Field
from datetime import datetime
import math
from loguru import logger
from pathlib import Path


class GPSCoordinates(BaseModel):
    """GPS coordinates extracted from photo"""
    latitude: float = Field(..., description="Latitude in decimal degrees")
    longitude: float = Field(..., description="Longitude in decimal degrees")
    altitude: Optional[float] = Field(None, description="Altitude in meters")
    accuracy: Optional[float] = Field(None, description="GPS accuracy in meters")
    timestamp: Optional[str] = Field(None, description="GPS timestamp")


class PhotoMetadata(BaseModel):
    """Complete photo metadata including GPS"""
    filename: str
    captured_at: Optional[str] = None
    camera_make: Optional[str] = None
    camera_model: Optional[str] = None
    gps: Optional[GPSCoordinates] = None
    width: int = 0
    height: int = 0


class PlanCoordinates(BaseModel):
    """Coordinates on electrical plan"""
    x: float = Field(..., description="X coordinate on plan (pixels)")
    y: float = Field(..., description="Y coordinate on plan (pixels)")
    plan_width: int
    plan_height: int


class PhotoOnPlan(BaseModel):
    """Photo mapped to electrical plan"""
    photo_path: str
    photo_metadata: PhotoMetadata
    plan_coordinates: PlanCoordinates
    distance_from_reference: Optional[float] = None  # meters
    notes: List[str] = Field(default_factory=list)


class GeoreferencedPlan(BaseModel):
    """Electrical plan with geographic reference points"""
    plan_path: str
    reference_points: List[Dict] = Field(
        default_factory=list,
        description="List of {x, y, lat, lon} reference points"
    )
    bounds: Optional[Dict] = None  # {north, south, east, west}
    scale: Optional[float] = None  # pixels per meter
    rotation: float = Field(default=0.0, description="Plan rotation in degrees")


class PhotoGPSService:
    """
    Service for extracting GPS from photos and mapping to electrical plans.

    Usage:
        service = PhotoGPSService()
        metadata = service.extract_photo_metadata("photo.jpg")
        if metadata.gps:
            plan_pos = service.map_gps_to_plan(metadata.gps, georeferenced_plan)
    """

    def __init__(self):
        """Initialize PhotoGPSService"""
        logger.info("📸 Initializing Photo GPS Service")

    def extract_photo_metadata(self, photo_path: str) -> PhotoMetadata:
        """
        Extract complete metadata from photo including GPS coordinates.

        Args:
            photo_path: Path to photo file

        Returns:
            PhotoMetadata with GPS coordinates if available

        Example:
            >>> metadata = service.extract_photo_metadata("site_photo.jpg")
            >>> if metadata.gps:
            >>>     print(f"Photo taken at {metadata.gps.latitude}, {metadata.gps.longitude}")
        """
        try:
            photo_path_obj = Path(photo_path)
            if not photo_path_obj.exists():
                raise FileNotFoundError(f"Photo not found: {photo_path}")

            img = Image.open(photo_path)

            metadata = PhotoMetadata(
                filename=photo_path_obj.name,
                width=img.width,
                height=img.height
            )

            # Extract EXIF data
            exif_data = img._getexif()
            if exif_data:
                # Extract camera info
                metadata.camera_make = exif_data.get(271)  # Make
                metadata.camera_model = exif_data.get(272)  # Model

                # Extract capture time
                datetime_original = exif_data.get(36867)  # DateTimeOriginal
                if datetime_original:
                    metadata.captured_at = datetime_original

                # Extract GPS
                gps_info = exif_data.get(34853)  # GPSInfo
                if gps_info:
                    gps_coords = self._parse_gps_info(gps_info)
                    if gps_coords:
                        metadata.gps = gps_coords
                        logger.success(f"✅ GPS extracted from {photo_path_obj.name}: {gps_coords.latitude:.6f}, {gps_coords.longitude:.6f}")

            return metadata

        except Exception as e:
            logger.error(f"Error extracting metadata from {photo_path}: {e}")
            return PhotoMetadata(filename=Path(photo_path).name)

    def _parse_gps_info(self, gps_info: Dict) -> Optional[GPSCoordinates]:
        """
        Parse GPS info from EXIF GPSInfo tag.

        Args:
            gps_info: GPS info dictionary from EXIF

        Returns:
            GPSCoordinates if valid GPS data found
        """
        try:
            # Get latitude
            gps_latitude = gps_info.get(2)  # GPSLatitude
            gps_latitude_ref = gps_info.get(1)  # GPSLatitudeRef

            # Get longitude
            gps_longitude = gps_info.get(4)  # GPSLongitude
            gps_longitude_ref = gps_info.get(3)  # GPSLongitudeRef

            if not all([gps_latitude, gps_latitude_ref, gps_longitude, gps_longitude_ref]):
                return None

            # Convert to decimal degrees
            lat = self._convert_to_degrees(gps_latitude)
            if gps_latitude_ref == 'S':
                lat = -lat

            lon = self._convert_to_degrees(gps_longitude)
            if gps_longitude_ref == 'W':
                lon = -lon

            # Get altitude (optional)
            altitude = None
            gps_altitude = gps_info.get(6)  # GPSAltitude
            if gps_altitude:
                altitude = float(gps_altitude)

            # Get timestamp (optional)
            gps_timestamp = None
            gps_date = gps_info.get(29)  # GPSDateStamp
            gps_time = gps_info.get(7)  # GPSTimeStamp
            if gps_date and gps_time:
                try:
                    hours = int(gps_time[0])
                    minutes = int(gps_time[1])
                    seconds = int(gps_time[2])
                    gps_timestamp = f"{gps_date} {hours:02d}:{minutes:02d}:{seconds:02d}"
                except:
                    pass

            return GPSCoordinates(
                latitude=lat,
                longitude=lon,
                altitude=altitude,
                timestamp=gps_timestamp
            )

        except Exception as e:
            logger.error(f"Error parsing GPS info: {e}")
            return None

    def _convert_to_degrees(self, value: Tuple) -> float:
        """
        Convert GPS coordinates from degrees/minutes/seconds to decimal degrees.

        Args:
            value: Tuple of (degrees, minutes, seconds)

        Returns:
            Decimal degrees
        """
        d = float(value[0])
        m = float(value[1])
        s = float(value[2])
        return d + (m / 60.0) + (s / 3600.0)

    def map_gps_to_plan(
        self,
        gps: GPSCoordinates,
        plan: GeoreferencedPlan
    ) -> Optional[PlanCoordinates]:
        """
        Map GPS coordinates to position on electrical plan.

        Uses georeferenced plan with known reference points to calculate
        the pixel position on the plan image.

        Args:
            gps: GPS coordinates from photo
            plan: Georeferenced electrical plan

        Returns:
            PlanCoordinates with x,y position on plan

        Algorithm:
            1. Use reference points to establish coordinate transformation
            2. Apply affine transformation to convert lat/lon to x/y
            3. Account for plan rotation and scale
        """
        try:
            if not plan.reference_points or len(plan.reference_points) < 2:
                logger.warning("Plan needs at least 2 reference points for georeferencing")
                return None

            # Simple 2-point linear interpolation
            # In production, use more sophisticated transformation (affine, polynomial)
            ref1 = plan.reference_points[0]
            ref2 = plan.reference_points[1]

            # Calculate relative position
            lat_range = ref2['lat'] - ref1['lat']
            lon_range = ref2['lon'] - ref1['lon']

            if lat_range == 0 or lon_range == 0:
                logger.error("Invalid reference points - no range")
                return None

            lat_ratio = (gps.latitude - ref1['lat']) / lat_range
            lon_ratio = (gps.longitude - ref1['lon']) / lon_range

            # Map to plan coordinates
            x_range = ref2['x'] - ref1['x']
            y_range = ref2['y'] - ref1['y']

            x = ref1['x'] + (lon_ratio * x_range)
            y = ref1['y'] + (lat_ratio * y_range)

            # Get plan dimensions (assume from reference or provided)
            plan_width = max(ref1['x'], ref2['x']) + 1000  # Default width
            plan_height = max(ref1['y'], ref2['y']) + 1000  # Default height

            # Clamp to plan bounds
            x = max(0, min(x, plan_width))
            y = max(0, min(y, plan_height))

            return PlanCoordinates(
                x=x,
                y=y,
                plan_width=plan_width,
                plan_height=plan_height
            )

        except Exception as e:
            logger.error(f"Error mapping GPS to plan: {e}")
            return None

    def calculate_distance(
        self,
        coord1: GPSCoordinates,
        coord2: GPSCoordinates
    ) -> float:
        """
        Calculate distance between two GPS coordinates using Haversine formula.

        Args:
            coord1: First GPS coordinate
            coord2: Second GPS coordinate

        Returns:
            Distance in meters
        """
        # Earth's radius in meters
        R = 6371000

        # Convert to radians
        lat1 = math.radians(coord1.latitude)
        lat2 = math.radians(coord2.latitude)
        dlat = math.radians(coord2.latitude - coord1.latitude)
        dlon = math.radians(coord2.longitude - coord1.longitude)

        # Haversine formula
        a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

        distance = R * c
        return distance

    def create_georeferenced_plan(
        self,
        plan_path: str,
        reference_points: List[Dict]
    ) -> GeoreferencedPlan:
        """
        Create a georeferenced electrical plan with known GPS reference points.

        Args:
            plan_path: Path to electrical plan image
            reference_points: List of dictionaries with x, y, lat, lon

        Returns:
            GeoreferencedPlan object

        Example:
            >>> reference_points = [
            >>>     {"x": 100, "y": 100, "lat": 45.5017, "lon": -73.5673},
            >>>     {"x": 1000, "y": 800, "lat": 45.5020, "lon": -73.5670}
            >>> ]
            >>> plan = service.create_georeferenced_plan("floor_plan.pdf", reference_points)
        """
        try:
            # Calculate bounds
            if reference_points:
                lats = [p['lat'] for p in reference_points]
                lons = [p['lon'] for p in reference_points]

                bounds = {
                    'north': max(lats),
                    'south': min(lats),
                    'east': max(lons),
                    'west': min(lons)
                }

                # Calculate scale (pixels per meter) if we have 2+ points
                scale = None
                if len(reference_points) >= 2:
                    ref1 = reference_points[0]
                    ref2 = reference_points[1]

                    # Pixel distance
                    pixel_dist = math.sqrt(
                        (ref2['x'] - ref1['x']) ** 2 +
                        (ref2['y'] - ref1['y']) ** 2
                    )

                    # Real world distance (meters)
                    gps1 = GPSCoordinates(latitude=ref1['lat'], longitude=ref1['lon'])
                    gps2 = GPSCoordinates(latitude=ref2['lat'], longitude=ref2['lon'])
                    real_dist = self.calculate_distance(gps1, gps2)

                    if real_dist > 0:
                        scale = pixel_dist / real_dist

            else:
                bounds = None
                scale = None

            return GeoreferencedPlan(
                plan_path=plan_path,
                reference_points=reference_points,
                bounds=bounds,
                scale=scale
            )

        except Exception as e:
            logger.error(f"Error creating georeferenced plan: {e}")
            return GeoreferencedPlan(
                plan_path=plan_path,
                reference_points=reference_points
            )

    def batch_process_photos(
        self,
        photo_paths: List[str],
        plan: GeoreferencedPlan
    ) -> List[PhotoOnPlan]:
        """
        Process multiple photos and map them all to the electrical plan.

        Args:
            photo_paths: List of photo file paths
            plan: Georeferenced electrical plan

        Returns:
            List of PhotoOnPlan objects
        """
        photos_on_plan = []

        for photo_path in photo_paths:
            try:
                # Extract metadata
                metadata = self.extract_photo_metadata(photo_path)

                if metadata.gps:
                    # Map to plan
                    plan_coords = self.map_gps_to_plan(metadata.gps, plan)

                    if plan_coords:
                        photo_on_plan = PhotoOnPlan(
                            photo_path=photo_path,
                            photo_metadata=metadata,
                            plan_coordinates=plan_coords
                        )

                        photos_on_plan.append(photo_on_plan)
                        logger.success(f"✅ Mapped {Path(photo_path).name} to plan at ({plan_coords.x:.0f}, {plan_coords.y:.0f})")
                else:
                    logger.warning(f"⚠️  No GPS data in {Path(photo_path).name}")

            except Exception as e:
                logger.error(f"Error processing {photo_path}: {e}")

        logger.info(f"📊 Processed {len(photos_on_plan)}/{len(photo_paths)} photos with GPS")
        return photos_on_plan
