'use strict';

// The three messages the onboarding funnel sends, in the order they go out.
//
// They are defined here rather than in the console so the copy, the intent and
// the parameter names travel together: change the words in one place and the
// simulated bubble, the free-text send and the event log all agree.
//
// Note which intent each one uses. Approval and the daily nudge both open the
// price screen, so both ride `seller_portal` and its frozen /s/{{1}} base - the
// same base an already-approved template was built against. Only the lot deck
// needs the second base, /lots/{{1}}.
const BROADCASTS = {
  onboarding_approved: {
    key: 'onboarding_approved',
    label: 'Approve & notify',
    intent: 'seller_portal',
    // Flips the signup to approved when it goes out, so "approved" in the console
    // can never mean anything except "we have told them".
    approves: true,
    // Its own template, because none of the existing ones say this. Its button
    // is a dynamic URL on the same /s/{{1}} base the price screen already uses.
    //
    //   Hi {{1}}, Your onboarding with Recykal.Market is complete -
    //   {{2}} is your customer ID.          button -> .../s/{{1}}
    //
    // WATI matches by name, and this one declares three: `name` for the body's
    // first slot, `custID` for the second, `1` for the button.
    template: 'omp_test_buyer_newlyonboard',
    params: [
      { name: 'name', value: '{{first_name}}' },
      { name: 'custID', value: '{{cust_id}}' },
      { name: '1', value: '{{token}}', button: true }
    ],
    // Deliberately the same words as the approved body, so what you read in the
    // console under simulate is what lands on the handset under template.
    copy: {
      name: 'omp_test_buyer_newlyonboard',
      button: 'Start Buying',
      body:
        'Hi {{first_name}}, Your onboarding with Recykal.Market is complete - ' +
        '{{cust_id}} is your customer ID.'
    }
  },

  lot_review: {
    key: 'lot_review',
    label: 'Send lots',
    intent: 'lot_select',
    // Already approved, already carrying its own /lots/{{1}} base.
    template: 'omp_test_buyer_check_lots',
    params: [
      { name: 'name', value: '{{first_name}}' },
      { name: 'num', value: '{{lot_count}}' },
      { name: 'qty', value: '{{lot_mt}}' },
      { name: 'mat', value: '{{lot_material}}' },
      { name: '1', value: '{{token}}', button: true }
    ],
    copy: null // the lot_select template's own wording is already right
  },

  price_nudge: {
    key: 'price_nudge',
    label: 'Send price nudge',
    intent: 'seller_portal',
    // The rate-confirmation template that already exists reads as a daily nudge
    // almost word for word - "your recent {{mat}} buying rate was Rs {{price}}
    // per kg, confirm rate change if any" - so the nudge needs nothing new
    // approved. {{rate}} falls back to the buyer's last posted price.
    template: 'omp_test_token_buyer1',
    params: [
      { name: 'NAME', value: '{{first_name}}' },
      { name: 'mat', value: '{{material}}' },
      { name: 'price', value: '{{rate}}' },
      { name: '1', value: '{{token}}', button: true }
    ],
    copy: {
      name: 'price_nudge_v1',
      button: 'Update my price',
      body:
        'Hi {{first_name}}, your {{material}} buying price of Rs {{rate}}/kg is up for the day. ' +
        'Confirm it or change it in one tap.'
    }
  }
};

module.exports = { BROADCASTS };
