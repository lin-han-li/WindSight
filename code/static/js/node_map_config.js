(function () {
  window.WindSightNodeMapConfig = {
    defaults: {
      zoneLabel: "未标定区域",
      accentColor: "#2f6fed",
      description: "风场边缘采集节点",
    },
    nodes: {
      WIN_001: {
        displayName: "北侧一号阵列",
        zoneLabel: "北侧风廊",
        mapX: 16,
        mapY: 24,
        accentColor: "#2f6fed",
        description: "北线入口采集节点，负责上游阵列状态回传。",
      },
      WIN_002: {
        displayName: "北侧二号阵列",
        zoneLabel: "北侧风廊",
        mapX: 34,
        mapY: 16,
        accentColor: "#19b8d6",
        description: "北线中段节点，承担主风廊补盲监测。",
      },
      WIN_003: {
        displayName: "东侧主阵列",
        zoneLabel: "东部高地",
        mapX: 58,
        mapY: 28,
        accentColor: "#5a7ff0",
        description: "东线主阵列节点，覆盖高地风机群。",
      },
      WIN_004: {
        displayName: "东侧前哨阵列",
        zoneLabel: "东部高地",
        mapX: 79,
        mapY: 22,
        accentColor: "#12b886",
        description: "东线前沿采集节点，适合观察突发波动。",
      },
      WIN_005: {
        displayName: "南侧一号阵列",
        zoneLabel: "南侧缓坡",
        mapX: 27,
        mapY: 73,
        accentColor: "#35a0e0",
        description: "南线回风区节点，重点关注温升和转速抖动。",
      },
      WIN_006: {
        displayName: "南侧二号阵列",
        zoneLabel: "南侧缓坡",
        mapX: 63,
        mapY: 77,
        accentColor: "#1ea97c",
        description: "南线末端节点，承担下游阵列状态补采。",
      },
    },
  };
})();
