"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface SignatureOverlayProps {
  fieldName: string;
  /** Position in PDF coordinates (bottom-left origin) */
  pdfX: number;
  pdfY: number;
  /** Size in PDF points */
  pdfW: number;
  pdfH: number;
  /** PDF page height for Y-axis flip */
  pageHeight: number;
  /** Scale factor: PDF points → screen pixels */
  scale: number;
  /** Callback when position changes (PDF coordinates) */
  onMove: (x: number, y: number) => void;
  /** Callback when size changes (PDF points) */
  onResize: (w: number, h: number) => void;
}

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const MIN_W_PDF = 50;
const MIN_H_PDF = 15;

export default function SignatureOverlay({
  fieldName,
  pdfX,
  pdfY,
  pdfW,
  pdfH,
  pageHeight,
  scale,
  onMove,
  onResize,
}: SignatureOverlayProps) {
  // Screen-space position and size for smooth dragging/resizing
  const [screenX, setScreenX] = useState(() => pdfX * scale);
  const [screenY, setScreenY] = useState(
    () => (pageHeight - pdfY - pdfH) * scale
  );
  const [screenW, setScreenW] = useState(() => pdfW * scale);
  const [screenH, setScreenH] = useState(() => pdfH * scale);

  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, elX: 0, elY: 0 });
  const resizeStartRef = useRef({
    mouseX: 0,
    mouseY: 0,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    corner: "bottom-right" as Corner,
  });

  // Sync from props when not actively interacting
  useEffect(() => {
    if (!isDragging && !isResizing) {
      setScreenX(pdfX * scale);
      setScreenY((pageHeight - pdfY - pdfH) * scale);
      setScreenW(pdfW * scale);
      setScreenH(pdfH * scale);
    }
  }, [pdfX, pdfY, pdfW, pdfH, pageHeight, scale, isDragging, isResizing]);

  // --- Drag logic ---

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      // Ignore if the click originated on a resize handle
      if ((e.target as HTMLElement).dataset.resizeHandle) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
      dragStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        elX: screenX,
        elY: screenY,
      };
      document.body.style.userSelect = "none";
    },
    [screenX, screenY]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;
      setScreenX(dragStartRef.current.elX + dx);
      setScreenY(dragStartRef.current.elY + dy);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.userSelect = "";

      // Convert final screen position back to PDF coordinates
      setScreenX((currentX) => {
        setScreenY((currentY) => {
          const newPdfX = currentX / scale;
          const newPdfY = pageHeight - currentY / scale - pdfH;
          onMove(newPdfX, newPdfY);
          return currentY;
        });
        return currentX;
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, scale, pageHeight, pdfH, onMove]);

  // --- Resize logic ---

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, corner: Corner) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      resizeStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        x: screenX,
        y: screenY,
        w: screenW,
        h: screenH,
        corner,
      };
      document.body.style.userSelect = "none";
    },
    [screenX, screenY, screenW, screenH]
  );

  useEffect(() => {
    if (!isResizing) return;

    const minW = MIN_W_PDF * scale;
    const minH = MIN_H_PDF * scale;

    const handleMouseMove = (e: MouseEvent) => {
      const { mouseX, mouseY, x, y, w, h, corner } = resizeStartRef.current;
      const dx = e.clientX - mouseX;
      const dy = e.clientY - mouseY;

      let newX = x;
      let newY = y;
      let newW = w;
      let newH = h;

      switch (corner) {
        case "top-left": {
          newW = Math.max(minW, w - dx);
          newH = Math.max(minH, h - dy);
          // Anchor is bottom-right: adjust position
          newX = x + (w - newW);
          newY = y + (h - newH);
          break;
        }
        case "top-right": {
          newW = Math.max(minW, w + dx);
          newH = Math.max(minH, h - dy);
          newY = y + (h - newH);
          break;
        }
        case "bottom-left": {
          newW = Math.max(minW, w - dx);
          newH = Math.max(minH, h + dy);
          newX = x + (w - newW);
          break;
        }
        case "bottom-right": {
          newW = Math.max(minW, w + dx);
          newH = Math.max(minH, h + dy);
          break;
        }
      }

      setScreenX(newX);
      setScreenY(newY);
      setScreenW(newW);
      setScreenH(newH);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.userSelect = "";

      // Read current values via setState updaters to get final state
      setScreenX((finalX) => {
        setScreenY((finalY) => {
          setScreenW((finalW) => {
            setScreenH((finalH) => {
              const newPdfW = finalW / scale;
              const newPdfH = finalH / scale;
              const newPdfX = finalX / scale;
              const newPdfY = pageHeight - finalY / scale - newPdfH;

              onResize(newPdfW, newPdfH);
              // If position changed (corners other than bottom-right can shift it)
              if (
                Math.abs(newPdfX - pdfX) > 0.01 ||
                Math.abs(newPdfY - pdfY) > 0.01
              ) {
                onMove(newPdfX, newPdfY);
              }
              return finalH;
            });
            return finalW;
          });
          return finalY;
        });
        return finalX;
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, scale, pageHeight, pdfX, pdfY, onMove, onResize]);

  // --- Corner handle component ---

  const cornerCursor = (corner: Corner) =>
    corner === "top-left" || corner === "bottom-right"
      ? "nwse-resize"
      : "nesw-resize";

  const cornerPosition = (corner: Corner): React.CSSProperties => {
    const offset = -4; // half of 8px handle
    switch (corner) {
      case "top-left":
        return { top: offset, left: offset };
      case "top-right":
        return { top: offset, right: offset };
      case "bottom-left":
        return { bottom: offset, left: offset };
      case "bottom-right":
        return { bottom: offset, right: offset };
    }
  };

  const renderHandle = (corner: Corner) => (
    <div
      key={corner}
      data-resize-handle="true"
      onMouseDown={(e) => handleResizeStart(e, corner)}
      style={{
        position: "absolute",
        width: 8,
        height: 8,
        cursor: cornerCursor(corner),
        backgroundColor: "rgb(236, 72, 153)", // pink-500
        border: "1.5px solid white",
        borderRadius: 2,
        zIndex: 1,
        ...cornerPosition(corner),
      }}
    />
  );

  const isActive = isDragging || isResizing;

  return (
    <div
      onMouseDown={handleDragStart}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        position: "absolute",
        left: screenX,
        top: screenY,
        width: screenW,
        height: screenH,
        background: "rgba(242, 217, 234, 0.5)",
        border: `${isHovered || isActive ? 2 : 1.5}px solid rgb(179, 77, 140)`,
        cursor: isDragging ? "grabbing" : "grab",
        boxShadow: isActive
          ? "0 2px 8px rgba(179, 77, 140, 0.35)"
          : "none",
        opacity: isHovered || isActive ? 1 : 0.9,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        transition: isActive
          ? "none"
          : "border-width 0.15s, opacity 0.15s, box-shadow 0.15s",
      }}
    >
      {/* Field name label */}
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          color: "rgb(190, 24, 93)", // pink-700
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "100%",
          padding: "0 4px",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {fieldName}
      </span>

      {/* Corner resize handles */}
      {renderHandle("top-left")}
      {renderHandle("top-right")}
      {renderHandle("bottom-left")}
      {renderHandle("bottom-right")}
    </div>
  );
}
