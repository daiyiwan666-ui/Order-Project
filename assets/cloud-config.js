/* Public client configuration only. Never put service-role keys here. */
window.ORDER_PROJECT_CLOUD = Object.freeze({
  url: 'https://qevuhefnniciwfnnhceo.supabase.co',
  publishableKey: 'sb_publishable_p7bKIIn5l1aES6Sq9NTl0A_Rwjx23bu'
});
document.documentElement.dataset.storage = new URLSearchParams(location.search).get('mode') === 'local' ? 'local' : 'cloud';
