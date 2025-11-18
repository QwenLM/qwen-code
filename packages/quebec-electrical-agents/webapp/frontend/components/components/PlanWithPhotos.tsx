/**
 * Plan with Photos Component - Display electrical plan with GPS-geolocated photos.
 *
 * Features:
 * - Shows electrical floor plan
 * - Overlays photo markers at GPS-calculated positions
 * - Click photo markers to view full photo
 * - Hover to see photo metadata
 */

"use client";

import { useState } from "react";
import { PlanWithPhotos as PlanWithPhotosType, PhotoOnPlan } from "@/types/artifact";
import { MapPin, Camera, X, Calendar, Map } from "lucide-react";
import Image from "next/image";

interface PlanWithPhotosProps {
  data: PlanWithPhotosType;
}

export default function PlanWithPhotos({ data }: PlanWithPhotosProps) {
  const [selectedPhoto, setSelectedPhoto] = useState<PhotoOnPlan | null>(null);
  const [hoveredPhoto, setHoveredPhoto] = useState<PhotoOnPlan | null>(null);

  return (
    <div className="space-y-6">
      {/* Plan container */}
      <div className="cyber-card">
        <div className="mb-4 flex items-center gap-2">
          <Map className="w-5 h-5 text-cyber-blue" />
          <h3 className="font-semibold">Plan Électrique avec Photos GPS</h3>
          <span className="text-sm text-muted-foreground ml-auto">
            {data.photos.length} photos géolocalisées
          </span>
        </div>

        {/* Plan with photo markers */}
        <div className="relative bg-muted rounded-lg overflow-hidden">
          {/* Electrical plan image */}
          <img
            src={data.plan_image_url || "/placeholder-plan.png"}
            alt="Plan électrique"
            className="w-full h-auto"
          />

          {/* Photo markers overlay */}
          {data.photos.map((photo, index) => {
            const { x, y, plan_width, plan_height } = photo.plan_coordinates;
            const xPercent = (x / plan_width) * 100;
            const yPercent = (y / plan_height) * 100;

            return (
              <div
                key={index}
                className="absolute photo-pin"
                style={{
                  left: `${xPercent}%`,
                  top: `${yPercent}%`,
                  transform: "translate(-50%, -50%)",
                }}
                onClick={() => setSelectedPhoto(photo)}
                onMouseEnter={() => setHoveredPhoto(photo)}
                onMouseLeave={() => setHoveredPhoto(null)}
              >
                <Camera className="w-4 h-4 relative z-10 text-white" />

                {/* Hover tooltip */}
                {hoveredPhoto === photo && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-card border border-border rounded-lg shadow-lg z-50 pointer-events-none">
                    <p className="text-sm font-semibold mb-1">
                      {photo.photo_metadata.filename}
                    </p>
                    {photo.photo_metadata.captured_at && (
                      <p className="text-xs text-muted-foreground mb-1">
                        📅 {new Date(photo.photo_metadata.captured_at).toLocaleString("fr-CA")}
                      </p>
                    )}
                    {photo.photo_metadata.gps && (
                      <p className="text-xs text-muted-foreground">
                        📍 {photo.photo_metadata.gps.latitude.toFixed(6)}, {photo.photo_metadata.gps.longitude.toFixed(6)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-accent border-2 border-white" />
            <span>Photo prise sur site</span>
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-accent" />
            <span>Position GPS</span>
          </div>
        </div>
      </div>

      {/* Photos list */}
      <div className="cyber-card space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <Camera className="w-5 h-5 text-cyber-purple" />
          <h3 className="font-semibold">Photos du Projet</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.photos.map((photo, index) => (
            <div
              key={index}
              className="cyber-card cursor-pointer hover:scale-105 transition-transform"
              onClick={() => setSelectedPhoto(photo)}
            >
              {/* Photo thumbnail */}
              <div className="aspect-video bg-muted rounded-md mb-3 overflow-hidden">
                <img
                  src={photo.photo_path || "/placeholder-photo.jpg"}
                  alt={photo.photo_metadata.filename}
                  className="w-full h-full object-cover"
                />
              </div>

              {/* Photo info */}
              <p className="text-sm font-medium truncate mb-2">
                {photo.photo_metadata.filename}
              </p>

              {photo.photo_metadata.captured_at && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                  <Calendar className="w-3 h-3" />
                  {new Date(photo.photo_metadata.captured_at).toLocaleDateString("fr-CA")}
                </div>
              )}

              {photo.photo_metadata.gps && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <MapPin className="w-3 h-3" />
                  {photo.photo_metadata.gps.latitude.toFixed(4)}, {photo.photo_metadata.gps.longitude.toFixed(4)}
                </div>
              )}

              {photo.distance_from_reference && (
                <div className="text-xs text-muted-foreground mt-1">
                  📏 {photo.distance_from_reference.toFixed(1)}m du point de référence
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Photo modal */}
      {selectedPhoto && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setSelectedPhoto(null)}
        >
          <div
            className="max-w-4xl w-full bg-card border border-border rounded-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="font-semibold">{selectedPhoto.photo_metadata.filename}</h3>
              <button
                onClick={() => setSelectedPhoto(null)}
                className="p-2 hover:bg-muted rounded-md transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal content */}
            <div className="p-4">
              {/* Full photo */}
              <div className="mb-4 rounded-lg overflow-hidden">
                <img
                  src={selectedPhoto.photo_path || "/placeholder-photo.jpg"}
                  alt={selectedPhoto.photo_metadata.filename}
                  className="w-full h-auto"
                />
              </div>

              {/* Metadata */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                {selectedPhoto.photo_metadata.captured_at && (
                  <div>
                    <p className="text-muted-foreground">Date de capture</p>
                    <p className="font-medium">
                      {new Date(selectedPhoto.photo_metadata.captured_at).toLocaleString("fr-CA")}
                    </p>
                  </div>
                )}

                {selectedPhoto.photo_metadata.camera_make && (
                  <div>
                    <p className="text-muted-foreground">Appareil</p>
                    <p className="font-medium">
                      {selectedPhoto.photo_metadata.camera_make} {selectedPhoto.photo_metadata.camera_model}
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-muted-foreground">Dimensions</p>
                  <p className="font-medium">
                    {selectedPhoto.photo_metadata.width} × {selectedPhoto.photo_metadata.height}px
                  </p>
                </div>

                {selectedPhoto.photo_metadata.gps && (
                  <>
                    <div>
                      <p className="text-muted-foreground">Latitude</p>
                      <p className="font-medium font-mono text-cyber-blue">
                        {selectedPhoto.photo_metadata.gps.latitude.toFixed(6)}°
                      </p>
                    </div>

                    <div>
                      <p className="text-muted-foreground">Longitude</p>
                      <p className="font-medium font-mono text-cyber-blue">
                        {selectedPhoto.photo_metadata.gps.longitude.toFixed(6)}°
                      </p>
                    </div>

                    {selectedPhoto.photo_metadata.gps.altitude && (
                      <div>
                        <p className="text-muted-foreground">Altitude</p>
                        <p className="font-medium">
                          {selectedPhoto.photo_metadata.gps.altitude.toFixed(1)}m
                        </p>
                      </div>
                    )}
                  </>
                )}

                <div>
                  <p className="text-muted-foreground">Position sur le plan</p>
                  <p className="font-medium">
                    X: {selectedPhoto.plan_coordinates.x.toFixed(0)}px, Y: {selectedPhoto.plan_coordinates.y.toFixed(0)}px
                  </p>
                </div>

                {selectedPhoto.distance_from_reference && (
                  <div>
                    <p className="text-muted-foreground">Distance du point de référence</p>
                    <p className="font-medium text-cyber-purple">
                      {selectedPhoto.distance_from_reference.toFixed(2)}m
                    </p>
                  </div>
                )}
              </div>

              {/* Notes */}
              {selectedPhoto.notes && selectedPhoto.notes.length > 0 && (
                <div className="mt-4 p-3 bg-muted rounded-lg">
                  <p className="text-sm font-medium mb-2">Notes:</p>
                  <ul className="text-sm space-y-1">
                    {selectedPhoto.notes.map((note, index) => (
                      <li key={index} className="text-muted-foreground">
                        • {note}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
