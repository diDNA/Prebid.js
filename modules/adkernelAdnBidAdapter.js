import * as utils from '../src/utils.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import {BANNER, VIDEO} from '../src/mediaTypes.js';
import {config} from '../src/config.js';

const DEFAULT_ADKERNEL_DSP_DOMAIN = 'tag.adkernel.com';
const DEFAULT_MIMES = ['video/mp4', 'video/webm', 'application/x-shockwave-flash', 'application/javascript'];
const DEFAULT_PROTOCOLS = [2, 3, 5, 6];
const DEFAULT_APIS = [1, 2];
const GVLID = 14;

function isRtbDebugEnabled(refInfo) {
  return refInfo.referer.indexOf('adk_debug=true') !== -1;
}

function buildImp(bidRequest) {
  let imp = {
    id: bidRequest.bidId,
    tagid: bidRequest.adUnitCode
  };
  let mediaType;
  let bannerReq = utils.deepAccess(bidRequest, `mediaTypes.banner`);
  let videoReq = utils.deepAccess(bidRequest, `mediaTypes.video`);
  if (bannerReq) {
    let sizes = canonicalizeSizesArray(bannerReq.sizes);
    imp.banner = {
      format: utils.parseSizesInput(sizes)
    };
    mediaType = BANNER;
  } else if (videoReq) {
    let size = canonicalizeSizesArray(videoReq.playerSize)[0];
    imp.video = {
      w: size[0],
      h: size[1],
      mimes: videoReq.mimes || DEFAULT_MIMES,
      protocols: videoReq.protocols || DEFAULT_PROTOCOLS,
      api: videoReq.api || DEFAULT_APIS
    };
    mediaType = VIDEO;
  }
  let bidFloor = getBidFloor(bidRequest, mediaType, '*');
  if (bidFloor) {
    imp.bidfloor = bidFloor;
  }
  return imp;
}

/**
 * Convert input array of sizes to canonical form Array[Array[Number]]
 * @param sizes
 * @return Array[Array[Number]]
 */
function canonicalizeSizesArray(sizes) {
  if (sizes.length === 2 && !utils.isArray(sizes[0])) {
    return [sizes];
  }
  return sizes;
}

function buildRequestParams(tags, bidderRequest) {
  let {auctionId, gdprConsent, uspConsent, transactionId, refererInfo} = bidderRequest;
  let req = {
    id: auctionId,
    tid: transactionId,
    site: buildSite(refererInfo),
    imp: tags
  };
  if (gdprConsent) {
    if (gdprConsent.gdprApplies !== undefined) {
      utils.deepSetValue(req, 'user.gdpr', ~~gdprConsent.gdprApplies);
    }
    if (gdprConsent.consentString !== undefined) {
      utils.deepSetValue(req, 'user.consent', gdprConsent.consentString);
    }
  }
  if (uspConsent) {
    utils.deepSetValue(req, 'user.us_privacy', uspConsent);
  }
  if (config.getConfig('coppa')) {
    utils.deepSetValue(req, 'user.coppa', 1);
  }
  return req;
}

function buildSite(refInfo) {
  let loc = utils.parseUrl(refInfo.referer);
  let result = {
    page: `${loc.protocol}://${loc.hostname}${loc.pathname}`,
    secure: ~~(loc.protocol === 'https')
  };
  if (self === top && document.referrer) {
    result.ref = document.referrer;
  }
  let keywords = document.getElementsByTagName('meta')['keywords'];
  if (keywords && keywords.content) {
    result.keywords = keywords.content;
  }
  return result;
}

function buildBid(tag) {
  let bid = {
    requestId: tag.impid,
    bidderCode: spec.code,
    cpm: tag.bid,
    width: tag.w,
    height: tag.h,
    creativeId: tag.crid,
    currency: 'USD',
    ttl: 720,
    netRevenue: true
  };
  if (tag.tag) {
    bid.ad = tag.tag;
    bid.mediaType = BANNER;
  } else if (tag.vast_url) {
    bid.vastUrl = tag.vast_url;
    bid.mediaType = VIDEO;
  }
  return bid;
}

function getBidFloor(bid, mediaType, sizes) {
  var floor;
  var size = sizes.length === 1 ? sizes[0] : '*';
  if (typeof bid.getFloor === 'function') {
    const floorInfo = bid.getFloor({currency: 'USD', mediaType, size});
    if (typeof floorInfo === 'object' && floorInfo.currency === 'USD' && !isNaN(parseFloat(floorInfo.floor))) {
      floor = parseFloat(floorInfo.floor);
    }
  }
  return floor;
}

export const spec = {
  code: 'adkernelAdn',
  gvlid: GVLID,
  supportedMediaTypes: [BANNER, VIDEO],
  aliases: ['engagesimply'],

  isBidRequestValid: function(bidRequest) {
    return 'params' in bidRequest &&
      (typeof bidRequest.params.host === 'undefined' || typeof bidRequest.params.host === 'string') &&
      typeof bidRequest.params.pubId === 'number' &&
      'mediaTypes' in bidRequest &&
      ('banner' in bidRequest.mediaTypes || 'video' in bidRequest.mediaTypes);
  },

  buildRequests: function(bidRequests, bidderRequest) {
    let dispatch = bidRequests.map(buildImp)
      .reduce((acc, curr, index) => {
        let bidRequest = bidRequests[index];
        let pubId = bidRequest.params.pubId;
        let host = bidRequest.params.host || DEFAULT_ADKERNEL_DSP_DOMAIN;
        acc[host] = acc[host] || {};
        acc[host][pubId] = acc[host][pubId] || [];
        acc[host][pubId].push(curr);
        return acc;
      }, {});

    let requests = [];
    Object.keys(dispatch).forEach(host => {
      Object.keys(dispatch[host]).forEach(pubId => {
        let request = buildRequestParams(dispatch[host][pubId], bidderRequest);
        requests.push({
          method: 'POST',
          url: `https://${host}/tag?account=${pubId}&pb=1${isRtbDebugEnabled(bidderRequest.refererInfo) ? '&debug=1' : ''}`,
          data: JSON.stringify(request)
        })
      });
    });
    return requests;
  },

  interpretResponse: function(serverResponse) {
    let response = serverResponse.body;
    if (!response.tags) {
      return [];
    }
    if (response.debug) {
      utils.logInfo(`ADKERNEL DEBUG:\n${response.debug}`);
    }
    return response.tags.map(buildBid);
  },

  getUserSyncs: function(syncOptions, serverResponses) {
    if (!serverResponses || serverResponses.length === 0) {
      return [];
    }
    if (syncOptions.iframeEnabled) {
      return buildSyncs(serverResponses, 'syncpages', 'iframe');
    } else if (syncOptions.pixelEnabled) {
      return buildSyncs(serverResponses, 'syncpixels', 'image');
    } else {
      return [];
    }
  }
};

function buildSyncs(serverResponses, propName, type) {
  return serverResponses.filter(rps => rps.body && rps.body[propName])
    .map(rsp => rsp.body[propName])
    .reduce((a, b) => a.concat(b), [])
    .map(syncUrl => ({type: type, url: syncUrl}));
}

registerBidder(spec);
