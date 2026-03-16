const fs = require('fs');
const path = './apps/web/src/widgets/route-map/ui/RouteMap.tsx';
let content = fs.readFileSync(path, 'utf8');

const searchStr = `  return (
    <div
      ref={containerRef}
      className="w-full h-full relative"
      data-testid="route-map"
      data-readonly={String(readonly)}
      data-draggable={String(draggable)}
    />
  );
}`;

const replaceStr = `  return (
    <div className="w-full h-full relative">
      <div
        ref={containerRef}
        className="absolute inset-0 z-0"
        data-testid="route-map"
        data-readonly={String(readonly)}
        data-draggable={String(draggable)}
      />
      {!readonly && onAddPointModeChange && (
        <button
          data-testid="route-map-add-point-toggle"
          data-active={String(isAddPointMode)}
          onClick={() => onAddPointModeChange(!isAddPointMode)}
          className="absolute left-[12px] top-[60px] w-[40px] h-[40px] rounded-[12px] border-none flex items-center justify-center cursor-pointer transition-all duration-200 z-[2500]"
          style={{
            background: isAddPointMode ? '#0ea5e9' : 'white',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          }}
        >
          {isAddPointMode ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="#0ea5e9" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
              <circle cx="12" cy="10" r="3" fill="none" stroke="white" strokeWidth="1.5"/>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="#4d4d4d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
              <circle cx="12" cy="10" r="3" fill="none" stroke="#4d4d4d" strokeWidth="1.5"/>
            </svg>
          )}
        </button>
      )}
    </div>
  );
}`;

content = content.replace(searchStr, replaceStr);
fs.writeFileSync(path, content, 'utf8');
