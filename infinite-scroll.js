'use strict';

/**
 * Triggers 'triggerInfiniteLoad' event when the user has scrolled
 * to the trigger point.
 */
function triggerLoadMore() {
  if ($('.loadingInfinite').isAlmostVisible()) {
    $(document).trigger('triggerInfiniteLoad');
  }
}

/**
 * Attempt to trigger infinite loading when resize and scroll browser
 * events are fired.
 */
Meteor.startup(function() {
  $(window).on('resize scroll', _.throttle(triggerLoadMore, 500));
});


/**
 * Attempt to trigger infinite loading when the route changes.
 */
Router.onAfterAction(function() {
  triggerLoadMore();
});

/**
 * jQuery plugin to determine whether an element is "almost visible".
 * @return {Boolean}
 */
jQuery.fn.isAlmostVisible = function jQueryIsAlmostVisible() {
  if (this.length === 0) {
    return;
  }
  var rect = this[0].getBoundingClientRect();

  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (jQuery(window).height() * 2) &&
    rect.right <= jQuery(window).width()
  );
};

/**
 * Enable infinite scrolling on a template.
 */
Blaze.TemplateInstance.prototype.infiniteScroll = function infiniteScroll(options) {
  var tpl = this, _defaults, countName, subManagerCache, subscriber, firstReady, disableLoaderAndUpdateFrom, loadMore, isApi;

  /*
   * Create options from defaults
   */
  _defaults = {
    // How many results to fetch per "page"
    perPage: 10,
    // The query to use when fetching our collection
    query: {},
    // The subscription manager to use (optional)
    subManager: null,
    // Collection to use for counting the amount of results
    collection: null,
    // Publication to subscribe to
    publication: null,
    // (optional) Count name, if null will use <publication>Count as default
    countName: null,

    //API OPTIONS expects a json response!

    //The url to connect to
    url: null,
    // the form key in the query string from the url (default from)
    fromQueryKey: 'from',
    // the till key in the query string from the url (default till)
    tillQueryKey: 'till',
    //The data path from your JSON response where you can get the data array.
    //You can use . and [index] notation if you need deeper access to the object
    resultDataKey: 'data',
    //A reactive array that keeps the data (also offline supported)
    reactiveArray: new ReactiveVar([])
  };
  options = _.extend({}, _defaults, options);

  // Validate the options
  isApi = false;
  if (typeof options.url !== "undefined" && options.url !== null) {
    check(options.url, String);
    check(options.perPage, Number);
    isApi = true;

    //Extend the Object to read value by key from a string
    //This enables the resultDataKey reading
    Object.byString = function(o, s) {
      s = s.replace(/\[(\w+)\]/g, '.$1'); // convert indexes to properties
      s = s.replace(/^\./, '');           // strip a leading dot
      var a = s.split('.');
      for (var i = 0, n = a.length; i < n; ++i) {
        var k = a[i];
        if (k in o) {
          o = o[k];
        } else {
          return;
        }
      }
      return o;
    }
  }
  // We use 'till' so that Meteor can continue to use the OpLogObserve driver
  // See: https://github.com/meteor/meteor/wiki/Oplog-Observe-Driver
  // (There are a few types of queries that still use PollingObserveDriver)
  tpl.from = new ReactiveVar(0);
  tpl.till = new ReactiveVar(options.perPage);

  if(!isApi) {
    check(options.collection, String);
    check(options.publication, String);

    // Collection exists?
    if (!Collections[options.collection]) {
      throw new Error('Collection does not exist: ', options.collection);
    }

    // Generate Default name if null is given

    if (typeof options.countName !== "undefined" && options.countName !== null) {
      countName = options.countName;
    }else{
      // Generate default Count name
      countName = options.publication + "Count";
    }

    // If we are using a subscription manager, cache the till variable with the subscription
    if(options.subManager){
      // Create the cache object if it doesn't exist
      if(!options.subManager._infinite){
        options.subManager._infinite = {};
        options.subManager._infinite[options.publication] = {};
      }
      subManagerCache = options.subManager._infinite[options.publication];
    }

    // Retrieve the initial page size
    if(subManagerCache && subManagerCache.limit){
      tpl.till.set(subManagerCache.limit);
    }else{
      check(options.perPage, Number);
      tpl.till.set(options.perPage);
    }
  }else{
    // The data comes from an external api, initial page size
    tpl.till.set(options.perPage);
  }

  // Create infiniteReady reactive var that we can use to track
  // whether or not the first result set has been received.
  firstReady = new ReactiveVar(false);
  tpl.infiniteReady = function(){
    return firstReady.get();
  };

  // Create subscription to the collection
  tpl.autorun(function() {
    // Rerun when the till changes
    var till = tpl.till.get();
    if (!isApi) {
      // If a Subscription Manager has been supplied, use that instead to create
      // the subscription. This is useful if you want to keep the subscription
      // from for multiple templates.
      if (options.subManager) {
        subscriber = options.subManager;
        // Save the till in the subscription manager so we can look it up later
        subManagerCache.limit = till;
      } else {
        subscriber = tpl;
      }

      tpl.infiniteSub = subscriber.subscribe(options.publication, till, options.query);
    } else {
      var from = tpl.from.get();
      //No need to overload the requests
      if(from !== till) {
        //Get the new data fragment and store it reactively
        //Generate API url with from till query
        var url = options.url + '&' + options.fromQueryKey + '=' + from + '&' + options.tillQueryKey + '=' + till;
        //Get the new data client side
        HTTP.get(url, function (error, result) {
          if (error) {
            console.log(error);
          } else if (result) {
            //Add the new data to current data
            //Concats current values with the new array retrieved from API
            options.reactiveArray.set(options.reactiveArray.get().concat(Object.byString(result, options.resultDataKey)));
            disableLoaderAndUpdateFrom();
          }
        });
      }
    }
  });

  if(!isApi){
    // Set infiniteReady to true when our subscriptions are ready
    tpl.autorun(function(){
      if(tpl.infiniteSub.ready()) {
        disableLoaderAndUpdateFrom();
      }
    });
  }

  disableLoaderAndUpdateFrom = function() {
    firstReady.set(true);
    tpl.from.set(tpl.till.get());
    tpl.$('.loadingInfinite').removeClass('loading');
  };

  /**
   * Load more results for this collection/dataset.
   */
  loadMore = function() {
    var count = 0;
    if(!isApi) {
      // Get the count of the publication
      if (!Counts.has(countName)) {
        throw new Error("Counts does not exist for publication: ", countName)
      }
      count = Counts.get(countName);
    }else{
      //Count doesn't matter to API
    }

    // Increase the till if it looks like there are more records
    if (count >= tpl.till.get() || isApi) {
      tpl.$('.loadingInfinite').addClass('loading');
      tpl.till.set(tpl.from.get() + options.perPage);
    }else{
      //Max results, no need for loader anymore
      tpl.$('.loadingInfinite').removeClass('loading');
    }
  };

  // Trigger loadMore when we've scrolled/resized close to revealing .loadingInfinite
  $(document).off('triggerInfiniteLoad');
  $(document).on('triggerInfiniteLoad', loadMore);
};
